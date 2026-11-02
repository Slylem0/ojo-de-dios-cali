// Ojo de Dios: Cali — aircraft proxy + recorder.
// - Function URL GET ?mode=live    -> live aircraft around Cali (proxied from adsb.lol, no CORS upstream)
// - Function URL GET ?mode=replay  -> recorded snapshots from S3 for the last N minutes
// - EventBridge schedule (1/min)   -> snapshot written to S3 (data/snapshots/YYYY-MM-DD/HHMM.json)
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET;
const CENTER = { lat: 3.4516, lon: -76.532 }; // Cali, Valle del Cauca
const RADIUS_NM = 150;
const UPSTREAM = `https://api.adsb.lol/v2/point/${CENTER.lat}/${CENTER.lon}/${RADIUS_NM}`;

const slim = (a) => ({
  hex: a.hex,
  cs: (a.flight || "").trim() || null,
  reg: a.r || null,
  type: a.t || null,
  desc: a.desc || null,
  lat: a.lat,
  lon: a.lon,
  alt: a.alt_baro === "ground" ? 0 : a.alt_baro ?? a.alt_geom ?? null,
  gnd: a.alt_baro === "ground",
  gs: a.gs ?? null,
  trk: a.track ?? a.true_heading ?? null,
  vr: a.baro_rate ?? a.geom_rate ?? null,
  sq: a.squawk || null,
  cat: a.category || null,
  mil: ((a.dbFlags ?? 0) & 1) === 1,
  emg: a.emergency && a.emergency !== "none" ? a.emergency : null,
});

async function fetchUpstream() {
  const res = await fetch(UPSTREAM, { headers: { "user-agent": "ojo-de-dios-cali/1.0" }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const body = await res.json();
  const ac = (body.ac || []).filter((a) => a.lat != null && a.lon != null).map(slim);
  return { t: Date.now(), src: "adsb.lol", ac };
}

async function fetchLive() {
  try {
    return await fetchUpstream();
  } catch (first) {
    try {
      return await fetchUpstream(); // community feed hiccups are usually transient
    } catch {
      // fall back to the most recent archived snapshot so the map never goes dark
      for (const back of [0, 1, 2]) {
        try {
          const o = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(Date.now() - back * 60_000) }));
          const snap = JSON.parse(await o.Body.transformToString());
          return { ...snap, src: "s3-cache", stale: true };
        } catch {}
      }
      throw first;
    }
  }
}

const keyFor = (t) => {
  const d = new Date(t).toISOString(); // UTC
  return `data/snapshots/${d.slice(0, 10)}/${d.slice(11, 13)}${d.slice(14, 16)}.json`;
};

async function record() {
  const snap = await fetchUpstream();
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: keyFor(snap.t),
      Body: JSON.stringify(snap),
      ContentType: "application/json",
    })
  );
  return snap;
}

async function replay(minutes) {
  const now = Date.now();
  const from = now - minutes * 60_000;
  const days = [...new Set([new Date(from).toISOString().slice(0, 10), new Date(now).toISOString().slice(0, 10)])];
  const keys = [];
  for (const day of days) {
    let token;
    do {
      const out = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `data/snapshots/${day}/`, ContinuationToken: token })
      );
      for (const o of out.Contents || []) keys.push(o.Key);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }
  const fromKey = keyFor(from);
  const wanted = keys.filter((k) => k >= fromKey).sort();
  const frames = [];
  for (let i = 0; i < wanted.length; i += 25) {
    const batch = await Promise.all(
      wanted.slice(i, i + 25).map(async (Key) => {
        try {
          const o = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }));
          return JSON.parse(await o.Body.transformToString());
        } catch {
          return null;
        }
      })
    );
    frames.push(...batch.filter(Boolean));
  }
  return { from, to: now, frames };
}

const json = (status, body, maxAge = 0) => ({
  statusCode: status,
  headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAge}` },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  // EventBridge scheduled invocation
  if (event?.source === "aws.events" || event?.["detail-type"] === "Scheduled Event") {
    const snap = await record();
    return { recorded: snap.ac.length };
  }
  const q = event?.queryStringParameters || {};
  try {
    if (q.mode === "replay") {
      const minutes = Math.min(Math.max(parseInt(q.minutes || "180", 10) || 180, 5), 24 * 60);
      return json(200, await replay(minutes), 30);
    }
    return json(200, await fetchLive(), 3);
  } catch (err) {
    console.error(err);
    return json(502, { error: String(err.message || err) });
  }
};
