// Her gün pg_cron tarafından tetiklenir.
// Maersk'in kendi sitesinin (maersk.com/schedules) kullandığı "synergy" iç API'sine
// doğrudan istek atar (Consumer-Key başlığı ile, MAERSK_CONSUMER_KEY secret'ı - bu site
// tarafından her ziyaretçinin tarayıcısına gönderilen genel/herkese-açık bir anahtar,
// hesap veya login gerektirmiyor). Önce port-calls ile Aliağa/İzmir'e uğrayan gemi
// listesini, sonra deadlines/queries ile her gemi-sefer için cut-off/VGM/ilk giriş
// tarihlerini çeker (bu tarihler geminin fiilen hangi hat tarafından işletildiğine göre
// MSK/HAP/CGM/ARK gibi farklı carrierCode'lar altında gelebilir - hangi carrier olursa
// olsun asıl kullanılan tarih odur, o yüzden carrierCode'a göre filtrelenmez).
// `gemiler` tablosunda adı olmayan gemi olarak ekler, adı zaten var olanların
// tarihlerini günceller. Eşleştirme anahtarı gemi adı + sefer no'dur.
// Değişiklikler `gorevler` tablosuna (Genel Ajanda) otomatik not olarak düşülür.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MAERSK_CONSUMER_KEY = Deno.env.get('MAERSK_CONSUMER_KEY')!;
const LIMAN = 'İzmir';
const PORT_CODE = '3TZA3JGPJXNY7'; // Aliağa (İzmir) - Maersk'in kendi port geo ID'si
const DAYS_AHEAD = 30;

interface MaerskPortCall {
  vesselName: string;
  vesselMaerskCode: string;
  marineContainerTerminalGeoCode: string;
  arrivalTime: string | null;
  departureTime: string | null;
  arrivalVoyageNumber: string | null;
  departureVoyageNumber: string | null;
}

interface MaerskDeadlineEntry {
  deadlineCode: string;
  transportActivity?: string;
  deadline: string;
}

interface MaerskDeadlineGroup {
  facilityId: string;
  vesselMaerskCode: string;
  voyageNumber: string;
  deadlines: MaerskDeadlineEntry[];
}

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

function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function toIsoDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function deadlineKey(vesselMaerskCode: string, voyageNumber: string): string {
  return `${vesselMaerskCode}|${voyageNumber}`;
}

function findDeadline(entries: MaerskDeadlineEntry[], code: string): string | null {
  const match = entries.find(
    (e) => e.deadlineCode === code && (!e.transportActivity || e.transportActivity === 'Export'),
  );
  return match?.deadline || null;
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
  return `🚢 Yeni gemi programa eklendi (İzmir - Maersk): ${s.ad} (İlk Giriş: ${formatTr(s.ilk_giris)}, Cut-Off: ${formatTr(s.cut_off)}, VGM: ${formatTr(s.vgm)}, ETA: ${formatTr(s.eta)}, ETD: ${formatTr(s.etd)})`;
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
  return `🚢 ${ad} programında revizyon (İzmir - Maersk): ${changes.join(', ')}`;
}

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const today = new Date();
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + DAYS_AHEAD);

    const portCallsUrl = `https://api.maersk.com/synergy/schedules/port-calls?portCode=${PORT_CODE}&fromDate=${ymd(today)}&toDate=${ymd(toDate)}&carrierCodes=MAEU`;
    const portCallsRes = await fetch(portCallsUrl, { headers: { 'Consumer-Key': MAERSK_CONSUMER_KEY } });
    if (!portCallsRes.ok) throw new Error(`Maersk port-calls API ${portCallsRes.status}: ${await portCallsRes.text()}`);
    const portCallsData = (await portCallsRes.json()) as { portCalls?: MaerskPortCall[] };
    const portCalls = (portCallsData.portCalls || []).filter((p) => p.vesselName);
    if (portCalls.length === 0) throw new Error('Hiç gemi bulunamadı, Maersk API formatı değişmiş olabilir');

    const deadlinesPayload = portCalls.map((p) => ({
      facilityId: p.marineContainerTerminalGeoCode,
      vesselMaerskCode: p.vesselMaerskCode,
      voyageNumber: p.departureVoyageNumber || p.arrivalVoyageNumber || '',
      deadlineGroupName: 'DOCUMENTATION',
    }));

    const deadlinesRes = await fetch('https://api.maersk.com/synergy/deadlines/queries', {
      method: 'POST',
      headers: { 'Consumer-Key': MAERSK_CONSUMER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(deadlinesPayload),
    });
    if (!deadlinesRes.ok) throw new Error(`Maersk deadlines API ${deadlinesRes.status}: ${await deadlinesRes.text()}`);
    const deadlineGroups = (await deadlinesRes.json()) as MaerskDeadlineGroup[];
    const deadlinesByKey = new Map(
      deadlineGroups.map((g) => [deadlineKey(g.vesselMaerskCode, g.voyageNumber), g.deadlines]),
    );

    const parsedShips: ParsedShip[] = portCalls.map((p) => {
      const voyage = p.departureVoyageNumber || p.arrivalVoyageNumber || '';
      const deadlines = deadlinesByKey.get(deadlineKey(p.vesselMaerskCode, voyage)) || [];
      return {
        ad: `${p.vesselName} ${voyage}`.trim(),
        liman: LIMAN,
        ilk_giris: toIsoDate(findDeadline(deadlines, 'SFGI')),
        cut_off: toIsoDate(findDeadline(deadlines, 'SGIN')),
        vgm: toIsoDateTime(findDeadline(deadlines, 'VGM')),
        eta: toIsoDate(p.arrivalTime),
        etd: toIsoDate(p.departureTime),
      };
    });

    const { data: existing, error: exError } = await supabase
      .from('gemiler')
      .select('id, ad, ilk_giris, cut_off, vgm, eta, etd')
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
    };
    const existingByName = new Map(
      (existing || []).map((r: ExistingRow) => [normalizeName(r.ad), r]),
    );

    const newShips = parsedShips.filter((s) => !existingByName.has(normalizeName(s.ad)));
    const candidateUpdates = parsedShips.filter((s) => existingByName.has(normalizeName(s.ad)));

    const agendaNotes: string[] = [];

    let inserted: string[] = [];
    if (newShips.length > 0) {
      const { data: insertedRows, error: insError } = await supabase
        .from('gemiler')
        .insert(newShips)
        .select('ad');
      if (insError) throw insError;
      inserted = (insertedRows || []).map((r: { ad: string }) => r.ad);
      for (const s of newShips) agendaNotes.push(buildNewShipNote(s));
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
      agendaNotes.push(note);
    }

    if (agendaNotes.length > 0) {
      const { error: noteError } = await supabase
        .from('gorevler')
        .insert(agendaNotes.map((metin) => ({ metin, tarih: null, tamamlandi_mi: false })));
      if (noteError) throw noteError;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        totalParsed: parsedShips.length,
        inserted,
        updated,
        agendaNotes,
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
