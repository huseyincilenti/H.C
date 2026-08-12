// Her gün pg_cron tarafından tetiklenir.
// Power Automate'in Supabase Storage'a attığı "izmir-gemi-programi.xlsx" (CMA CGM
// / TCE Ege Liman sefer programı) dosyasını okur, `gemiler` tablosunda adı
// olmayan gemileri ekler, adı zaten var olan gemilerin tarihlerini (ETA/ETD/
// cut-off/VGM revizyonu) günceller. Eşleştirme anahtarı gemi adıdır.
// Değişiklikler `gorevler` tablosuna (Genel Ajanda) otomatik not olarak düşülür.
import { createClient } from 'npm:@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'gemi-pdf';
const FILE_PATH = 'izmir-gemi-programi.xlsx';
const LIMAN = 'İzmir';

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

function toIsoDate(d: Date | null | undefined): string | null {
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toIsoDateTime(d: Date | null | undefined): string | null {
  if (!d || isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19);
}

// XLSX satırındaki bir hücreyi Date nesnesine çevirir. Excel'in kendi tarih
// tipi olarak geldiyse doğrudan kullanılır; metin olarak geldiyse (ör.
// "7/25/2026 2:00:00 AM") JS Date parse'ına bırakılır.
function cellToDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? null : d;
}

function parseIzmirGemiProgrami(rows: Record<string, unknown>[]): ParsedShip[] {
  return rows
    .filter((r) => r['Vessel Name'])
    .map((r) => {
      const vesselName = String(r['Vessel Name']).trim();
      const localVoyage = r['Local Voyage'] ? String(r['Local Voyage']).trim() : '';
      const voyage = r['Voyage'] ? String(r['Voyage']).trim() : '';
      const ad = `${vesselName} ${localVoyage || voyage}`.trim();

      return {
        ad,
        liman: LIMAN,
        ilk_giris: null,
        cut_off: toIsoDate(cellToDate(r['Port Cut-off'])),
        vgm: toIsoDateTime(cellToDate(r['VGM Cut-off'])),
        eta: toIsoDate(cellToDate(r['ETA Berth'])),
        etd: toIsoDate(cellToDate(r['ETD'])),
      };
    });
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
  return `🚢 Yeni gemi programa eklendi (İzmir): ${s.ad} (Cut-Off: ${formatTr(s.cut_off)}, VGM: ${formatTr(s.vgm)}, ETA: ${formatTr(s.eta)}, ETD: ${formatTr(s.etd)})`;
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
  return `🚢 ${ad} programında revizyon (İzmir): ${changes.join(', ')}`;
}

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: fileBlob, error: dlError } = await supabase.storage.from(BUCKET).download(FILE_PATH);
    if (dlError) throw dlError;

    const buffer = new Uint8Array(await fileBlob.arrayBuffer());
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { raw: true }) as Record<string, unknown>[];

    const parsedShips = parseIzmirGemiProgrami(rows);
    if (parsedShips.length === 0) throw new Error('Hiç gemi bulunamadı, dosya formatı değişmiş olabilir');

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
      for (const s of newShips) agendaNotes.push({ metin: buildNewShipNote(s), gemi_adi: s.ad });
    }

    let updated: string[] = [];
    for (const s of candidateUpdates) {
      const oldRow = existingByName.get(normalizeName(s.ad))!;
      const note = buildChangeNote(s.ad, oldRow, s);
      if (!note) continue;

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
      agendaNotes.push({ metin: note, gemi_adi: oldRow.ad });
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
