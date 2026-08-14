// Her gün pg_cron tarafından tetiklenir.
// Power Automate'in Supabase Storage'a attığı "antalya-gemi-programi.pdf" dosyasını
// okur, MSC'nin gemi programı tablosunu ayrıştırır. Adı `gemiler` tablosunda
// olmayan gemileri ekler, adı zaten var olan gemilerin tarihlerini (ör. ETA/
// cut-off revizyonu) günceller. Eşleştirme anahtarı gemi adıdır.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { extractText, getDocumentProxy } from 'npm:unpdf@0.11.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'gemi-pdf';
const FILE_PATH = 'antalya-gemi-programi.pdf';
const LIMAN = 'Antalya';

interface ParsedShip {
  ad: string;
  liman: string;
  ilk_giris: string | null;
  cut_off: string | null;
  vgm: string | null;
  eta: string | null;
  etd: string | null;
}

function normalizeName(s: string): string {
  return (s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function toIsoDate(d: string): string | null {
  const m = d.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function toIsoDateTime(d: string): string | null {
  const m = d.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, HH, MI] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${HH.padStart(2, '0')}:${MI}:00`;
}

function datesAfterLabel(text: string, label: string, count: number): string[] {
  const idx = text.indexOf(label);
  if (idx === -1) return [];
  const segment = text.slice(idx + label.length, idx + label.length + 400);
  const matches = segment.match(/\d{1,2}\.\d{1,2}\.\d{4}(?:-\d{1,2}:\d{2})?/g) || [];
  return matches.slice(0, count);
}

// Başlık bölümündeki gemi adı + sefer no bloklarını ayrıştırır.
// PDF'te bazı gemiler için sefer no revizyonu (ör. "AX628R" -> "AX629") ayrı bir
// satır olarak, "***GEMI DOLU***" ibaresi de ayrı bir satır olarak düşer.
// Bu fonksiyon revizyonu bir önceki gemiye uygular, "GEMI DOLU" ibaresini de
// bir önceki geminin adına " - DOLU" olarak ekler.
function extractShipColumns(headerSegment: string): string[] {
  const tokens = headerSegment.split(/\s+/).filter(Boolean);
  const voyageRe = /^[A-Z]{1,3}\d{3,4}R?$/;
  const clean = (t: string) => t.replace(/\*+/g, '');

  const columns: string[] = [];
  const fullFlags: boolean[] = [];
  let pendingNameWords: string[] = [];

  for (const raw of tokens) {
    const t = clean(raw);
    if (!t) continue;

    if (t === 'GEMI' || t === 'DOLU') {
      if (columns.length > 0) fullFlags[columns.length - 1] = true;
      continue;
    }

    if (voyageRe.test(t)) {
      if (pendingNameWords.length > 0) {
        columns.push(`${pendingNameWords.join(' ')} ${t}`);
        fullFlags.push(false);
        pendingNameWords = [];
      } else if (columns.length > 0) {
        // Önceki gemi için sefer no revizyonu
        const prevName = columns[columns.length - 1].replace(/\s+[A-Z]{1,3}\d{3,4}R?$/, '');
        columns[columns.length - 1] = `${prevName} ${t}`;
      }
      continue;
    }

    if (/^[A-ZÇĞİÖŞÜ]+$/.test(t)) {
      pendingNameWords.push(t);
      if (pendingNameWords.length > 3) pendingNameWords.shift();
    } else {
      pendingNameWords = [];
    }
  }

  return columns.map((name, i) => (fullFlags[i] ? `${name} - DOLU` : name));
}

function parseAntalyaGemiProgrami(rawText: string): ParsedShip[] {
  const text = rawText.replace(/\s+/g, ' ').trim();

  const headerStart = text.indexOf('QTERMINALS ANTALYA');
  const headerEnd = text.indexOf('IMO NUMARASI');
  if (headerStart === -1 || headerEnd === -1) {
    throw new Error('Beklenen PDF başlık bölümü bulunamadı (format değişmiş olabilir)');
  }
  const headerSegment = text.slice(headerStart + 'QTERMINALS ANTALYA'.length, headerEnd);

  const shipNames = extractShipColumns(headerSegment);
  const n = shipNames.length;
  if (n === 0) throw new Error('Hiç gemi bulunamadı, PDF formatı değişmiş olabilir');

  const ilkGiris = datesAfterLabel(text, 'ARDIYESIZ ILK DOLUM', n);
  const cutOff = datesAfterLabel(text, 'GATE-IN/STUFFINGS CUT-OFF', n);
  const vgm = datesAfterLabel(text, 'DECLARATIONS CUT-OFF', n);
  const eta = datesAfterLabel(text, 'ANTALYA ETA', n);
  const etd = datesAfterLabel(text, 'ANTALYA ETD', n);

  return shipNames.map((ad, i) => ({
    ad,
    liman: LIMAN,
    ilk_giris: ilkGiris[i] ? toIsoDate(ilkGiris[i]) : null,
    cut_off: cutOff[i] ? toIsoDate(cutOff[i]) : null,
    vgm: vgm[i] ? toIsoDateTime(vgm[i]) : null,
    eta: eta[i] ? toIsoDate(eta[i]) : null,
    etd: etd[i] ? toIsoDate(etd[i]) : null,
  }));
}

const FIELD_LABELS: Record<string, string> = {
  ilk_giris: 'İlk Giriş',
  cut_off: 'Cut-Off',
  vgm: 'VGM',
  eta: 'ETA',
  etd: 'ETD',
};

function formatTr(value: string | null | undefined): string {
  if (!value) return '-';
  const [datePart, timePart] = value.split('T');
  const [y, m, d] = datePart.split('-');
  return timePart ? `${d}.${m}.${y} ${timePart.slice(0, 5)}` : `${d}.${m}.${y}`;
}

function buildNewShipNote(s: ParsedShip): string {
  return `🚢 Yeni gemi programa eklendi: ${s.ad} (İlk Giriş: ${formatTr(s.ilk_giris)}, Cut-Off: ${formatTr(s.cut_off)}, VGM: ${formatTr(s.vgm)}, ETA: ${formatTr(s.eta)}, ETD: ${formatTr(s.etd)})`;
}

type DateFields = {
  ilk_giris: string | null;
  cut_off: string | null;
  vgm: string | null;
  eta: string | null;
  etd: string | null;
};

function buildChangeNote(ad: string, oldRow: DateFields, newRow: DateFields): string | null {
  const fields: (keyof DateFields)[] = ['ilk_giris', 'cut_off', 'vgm', 'eta', 'etd'];
  const changes: string[] = [];
  for (const f of fields) {
    if ((oldRow[f] || null) !== (newRow[f] || null)) {
      changes.push(`${FIELD_LABELS[f]}: ${formatTr(oldRow[f])} → ${formatTr(newRow[f])}`);
    }
  }
  if (changes.length === 0) return null;
  return `🚢 ${ad} programında revizyon: ${changes.join(', ')}`;
}

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: pdfBlob, error: dlError } = await supabase.storage.from(BUCKET).download(FILE_PATH);
    if (dlError) throw dlError;

    const buffer = new Uint8Array(await pdfBlob.arrayBuffer());
    const pdf = await getDocumentProxy(buffer);
    const { text } = await extractText(pdf, { mergePages: true });

    const parsedShips = parseAntalyaGemiProgrami(text);

    const { data: existing, error: exError } = await supabase
      .from('gemiler')
      .select('id, ad, ilk_giris, cut_off, vgm, eta, etd, imo')
      .eq('liman', LIMAN);
    if (exError) throw exError;

    type ExistingRow = {
      id: number;
      ad: string;
      ilk_giris: string | null;
      cut_off: string | null;
      vgm: string | null;
      eta: string | null;
      etd: string | null;
      imo: string | null;
    };
    const existingByName = new Map(
      (existing || []).map((r: ExistingRow) => [normalizeName(r.ad), r]),
    );

    // Bu gemilerden biri aktif (tamamlanmamış) bir sevkiyatta seçili mi diye
    // kontrol etmek için önceden çekiyoruz; gemi programı revize olunca bu
    // sevkiyatların donmuş `gemi` kopyasını da otomatik tazeleyeceğiz.
    const { data: activeShipments, error: shipFetchError } = await supabase
      .from('sevkiyatlar')
      .select('id, gemi')
      .neq('asama', 'Tamamlandı')
      .not('gemi', 'is', null);
    if (shipFetchError) throw shipFetchError;

    // Ajandaya not sadece bizim aktif bir sevkiyatımızda kullanılan bir gemi
    // etkileniyorsa düşülür - limandaki her yeni/revize gemi için değil,
    // yoksa ajanda alakasız gemilerle boğuluyor.
    const activeShipNames = new Set(
      (activeShipments || [])
        .map((row: { gemi: { ad?: string } | null }) => row.gemi?.ad)
        .filter((ad: string | undefined): ad is string => !!ad)
        .map(normalizeName),
    );

    async function refreshActiveShipments(oldRow: ExistingRow, s: ParsedShip): Promise<void> {
      const matches = (activeShipments || []).filter(
        (row: { id: string; gemi: { ad?: string } | null }) =>
          row.gemi && normalizeName(row.gemi.ad || '') === normalizeName(oldRow.ad),
      );
      if (matches.length === 0) return;
      const freshGemi = {
        id: oldRow.id,
        ad: oldRow.ad,
        liman: LIMAN,
        ilk: s.ilk_giris,
        cut: s.cut_off,
        vgm: s.vgm,
        eta: s.eta,
        etd: s.etd,
        imo: oldRow.imo ?? null,
      };
      const { error: shipUpdError } = await supabase
        .from('sevkiyatlar')
        .update({ gemi: freshGemi, gemi_revize_bildirimi: true })
        .in('id', matches.map((r: { id: string }) => r.id));
      if (shipUpdError) throw shipUpdError;
    }

    const newShips = parsedShips.filter((s) => !existingByName.has(normalizeName(s.ad)));
    const candidateUpdates = parsedShips.filter((s) => existingByName.has(normalizeName(s.ad)));

    const agendaNotes: { metin: string; gemi_adi: string }[] = [];

    let inserted: string[] = [];
    if (newShips.length > 0) {
      const { data: insertedRows, error: insError } = await supabase
        .from('gemiler')
        .insert(newShips)
        .select('ad');
      if (insError) throw insError;
      inserted = (insertedRows || []).map((r: { ad: string }) => r.ad);
      for (const s of newShips) {
        if (activeShipNames.has(normalizeName(s.ad))) {
          agendaNotes.push({ metin: buildNewShipNote(s), gemi_adi: s.ad });
        }
      }
    }

    // Var olan gemiler için sadece gerçekten bir tarih değiştiyse günceller
    // ve ajandaya ne değiştiğini yazan bir not düşer.
    let updated: string[] = [];
    for (const s of candidateUpdates) {
      const oldRow = existingByName.get(normalizeName(s.ad))!;
      const note = buildChangeNote(s.ad, oldRow, s);
      if (!note) continue; // hiçbir şey değişmemiş, dokunma

      const { error: updError } = await supabase
        .from('gemiler')
        .update({
          ilk_giris: s.ilk_giris,
          cut_off: s.cut_off,
          vgm: s.vgm,
          eta: s.eta,
          etd: s.etd,
        })
        .eq('id', oldRow.id);
      if (updError) throw updError;
      updated.push(s.ad);
      if (activeShipNames.has(normalizeName(oldRow.ad))) {
        // gemi_adi burada oldRow.ad'dan alınır çünkü sevkiyatlara bağlanan gemi kaydı
        // her zaman gemiler tablosundaki mevcut isimle (oldRow.ad) eşleşir, yeni parse
        // edilen s.ad ile ufak biçim farkları olabilir.
        agendaNotes.push({ metin: note, gemi_adi: oldRow.ad });
      }
      await refreshActiveShipments(oldRow, s);
    }

    if (agendaNotes.length > 0) {
      const { error: noteError } = await supabase
        .from('gorevler')
        .insert(agendaNotes.map(({ metin, gemi_adi }) => ({ metin, gemi_adi, tarih: null, tamamlandi_mi: false })));
      if (noteError) throw noteError;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        totalParsed: parsedShips.length,
        inserted,
        updated,
        agendaNotes: agendaNotes.map((a) => a.metin),
        parsed: parsedShips,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ ok: false, error: String((err as Error)?.message || err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
