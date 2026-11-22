import "./style.css";
import { identify, IdentifyError } from "./gemini.js";
import { rarityFor, RARITY_RANK } from "./rarity.js";
import {
  albumAll,
  albumPut,
  albumDelete,
  cacheGet,
  cachePut,
  cacheDelete,
  printsAll,
  printPut,
  printDelete,
  deviceId,
  seenNotice,
  markNoticeSeen,
} from "./db.js";

const KEY_STORAGE = "fieldguide.geminiKey";
// Bumped when the card's fields change, so an old cached plate is written again
// with the full back instead of being served shallow forever.
const CARD_VERSION = 3;
// Zoom is a centre crop of the same feed, so it costs nothing to ask for a
// bigger frame: the crop still has pixels at the far end of the range.
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.5;
// Long edge of the photograph kept for the card and sent to Gemini.
const PHOTO_EDGE = 1280;
const el = (id) => document.getElementById(id);

const ui = {
  cameraStage: el("cameraStage"),
  viewfinder: el("viewfinder"),
  noCamera: el("noCamera"),
  noCameraCopy: el("noCameraCopy"),
  retryCamera: el("retryCamera"),
  shutter: el("shutter"),
  keyButton: el("keyButton"),
  albumButton: el("albumButton"),
  uploadButton: el("uploadButton"),
  flashButton: el("flashButton"),
  zoomRow: el("zoomRow"),
  zoomValue: el("zoomValue"),
  zoomIn: el("zoomIn"),
  zoomOut: el("zoomOut"),
  stateWord: el("stateWord"),
  fileInput: el("fileInput"),
  pickButton: el("pickButton"),
  readingStage: el("readingStage"),
  readingPhoto: el("readingPhoto"),
  cardStage: el("cardStage"),
  card: el("card"),
  cardPhoto: el("cardPhoto"),
  cardStamp: el("cardStamp"),
  stampTier: el("stampTier"),
  frontKind: el("frontKind"),
  frontDate: el("frontDate"),
  backKind: el("backKind"),
  backName: el("backName"),
  backTech: el("backTech"),
  backClass: el("backClass"),
  backDef: el("backDef"),
  backAnatomy: el("backAnatomy"),
  backHistory: el("backHistory"),
  backWhy: el("backWhy"),
  blockWhat: el("blockWhat"),
  blockHow: el("blockHow"),
  blockHistory: el("blockHistory"),
  blockWhy: el("blockWhy"),
  backClosing: el("backClosing"),
  backMeta: el("backMeta"),
  backTags: el("backTags"),
  backUncertain: el("backUncertain"),
  turnButton: el("turnButton"),
  keepButton: el("keepButton"),
  againButton: el("againButton"),
  albumStage: el("albumStage"),
  albumGrid: el("albumGrid"),
  albumEmpty: el("albumEmpty"),
  albumClose: el("albumClose"),
  slipStage: el("slipStage"),
  slipReason: el("slipReason"),
  slipBack: el("slipBack"),
  statusLine: el("statusLine"),
  notice: el("notice"),
  noticeOk: el("noticeOk"),
  keySheet: el("keySheet"),
  apiKey: el("apiKey"),
  saveKey: el("saveKey"),
  forgetKey: el("forgetKey"),
  closeSheet: el("closeSheet"),
  keyStatus: el("keyStatus"),
};

let stream = null;
let apiKey = readStoredKey();
let busy = false;
let flipped = false;
let statusTimer = 0;
/** starting | live | blocked */
let cameraState = "starting";
let torchOn = false;
let flashSupported = false;
let zoom = 1;
/** camera | album */
let cardOrigin = "camera";
/** A plate just read and not yet kept: nothing of it is stored until Keep. */
let pendingPlate = null;

// ---------------------------------------------------------------- boot

if (apiKey) {
  updateLedger();
} else {
  openSheet();
}
refreshCounts();
if (!seenNotice()) ui.notice.hidden = false;
startCamera();

// ---------------------------------------------------------------- camera

async function startCamera() {
  stopStream();
  cameraState = "starting";
  ui.cameraStage.classList.remove("is-blocked");
  ui.noCamera.hidden = true;
  updateLedger();

  if (!navigator.mediaDevices?.getUserMedia) {
    blockCamera("This browser can't reach a camera on this page. A photo works just as well.");
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        // Left to itself a browser often hands back a 640x480 preview, which
        // is soft on a phone and leaves nothing to crop into when zoomed.
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  } catch (error) {
    blockCamera(cameraMessage(error));
    return;
  }

  ui.viewfinder.srcObject = stream;
  try {
    await ui.viewfinder.play();
  } catch {
    /* a still first frame is enough to capture from */
  }

  cameraState = "live";
  ui.noCamera.hidden = true;
  ui.cameraStage.classList.remove("is-blocked");
  sharpenTrack();
  watchFlash();
  ui.zoomRow.hidden = false;
  applyZoom(zoom);
  updateLedger();
}

/**
 * The default preview is often a coarse, fixed-focus stream. Ask the track for
 * the largest mode it reports and for continuous focus, and keep whatever we
 * already have if the camera refuses.
 */
async function sharpenTrack() {
  const track = stream?.getVideoTracks?.()[0];
  if (!track?.getCapabilities || !track.applyConstraints) return;
  const capabilities = track.getCapabilities() ?? {};
  const constraints = {};
  const advanced = [];
  if (capabilities.width?.max && capabilities.height?.max) {
    constraints.width = { ideal: capabilities.width.max };
    constraints.height = { ideal: capabilities.height.max };
  }
  if (capabilities.focusMode?.includes?.("continuous")) {
    advanced.push({ focusMode: "continuous" });
  }
  if (advanced.length) constraints.advanced = advanced;
  if (!Object.keys(constraints).length) return;
  try {
    await track.applyConstraints(constraints);
  } catch {
    /* the stream we already have is still usable */
  }
}

/** Show the zoom the feed is cropped to, and keep the buttons honest at the ends. */
function applyZoom(next) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next / ZOOM_STEP) * ZOOM_STEP));
  ui.viewfinder.style.setProperty("--zoom", String(zoom));
  ui.zoomValue.textContent = `${zoom.toFixed(1)}×`;
  ui.zoomOut.disabled = zoom <= ZOOM_MIN;
  ui.zoomIn.disabled = zoom >= ZOOM_MAX;
}

// The torch is a rear-camera capability, not a universal one: show the control
// only when the track actually reports it.
function watchFlash() {
  const track = stream?.getVideoTracks?.()[0];
  const capabilities = track?.getCapabilities?.() ?? {};
  flashSupported = Boolean(capabilities.torch);
  ui.flashButton.hidden = !flashSupported;
  setTorch(false);
}

function setTorch(on) {
  torchOn = on;
  ui.flashButton.classList.toggle("is-on", on);
  ui.flashButton.setAttribute("aria-pressed", String(on));
  ui.flashButton.textContent = on ? "flash on" : "flash";
}

async function toggleFlash() {
  if (!flashSupported || !stream) return;
  const track = stream.getVideoTracks()[0];
  const next = !torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: next }] });
    setTorch(next);
  } catch {
    setTorch(false);
    showStatus("This camera won't hold the flash on. Try again in a moment.", 4500);
  }
}

function stopStream() {
  flashSupported = false;
  ui.flashButton.hidden = true;
  ui.zoomRow.hidden = true;
  setTorch(false);
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
  ui.viewfinder.srcObject = null;
}

function cameraMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "The browser blocked the camera — permission was denied, or this page is embedded without camera access. You can allow the camera and try again, or use a photo.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "This device doesn't have a camera the browser can use. A photo works just as well.";
    case "NotReadableError":
    case "AbortError":
      return "The camera is busy in another app. Close it and try again, or use a photo.";
    default:
      return "The camera didn't start. You can try again, or use a photo.";
  }
}

function blockCamera(message) {
  cameraState = "blocked";
  ui.noCameraCopy.textContent = message;
  ui.noCamera.hidden = false;
  ui.cameraStage.classList.add("is-blocked");
  updateLedger();
}

function updateLedger() {
  ui.stateWord.textContent = busy
    ? "reading"
    : !apiKey
      ? "no key"
      : cameraState === "blocked"
        ? "no camera"
        : cameraState === "starting"
          ? "starting camera"
          : "ready";
}

async function capture() {
  if (busy) return;
  if (!apiKey) {
    openSheet();
    return;
  }
  if (!stream) {
    showStatus("No live camera here — choose a photo instead.", 6000);
    ui.fileInput.click();
    return;
  }
  const photo = grabFrame();
  if (!photo) {
    showStatus("The camera is still warming up. Tap once more.", 5000);
    return;
  }
  await readPhoto(photo);
}

/**
 * Draw what the viewfinder is showing. The preview covers the stage, so the
 * visible photograph is a centre crop of the sensor frame already; zoom
 * narrows that crop by the same factor instead of stretching a soft image.
 */
function grabFrame() {
  const video = ui.viewfinder;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;

  const viewWidth = video.clientWidth || width;
  const viewHeight = video.clientHeight || height;
  const cover = Math.max(viewWidth / width, viewHeight / height);
  const sourceWidth = Math.min(width, viewWidth / (cover * zoom));
  const sourceHeight = Math.min(height, viewHeight / (cover * zoom));
  const sourceX = (width - sourceWidth) / 2;
  const sourceY = (height - sourceHeight) / 2;

  const size = fit(sourceWidth, sourceHeight, PHOTO_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    size.width,
    size.height,
  );
  return canvas.toDataURL("image/jpeg", 0.9);
}

function fit(width, height, longest) {
  const scale = Math.min(1, longest / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

async function fileToPhoto(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const size = fit(bitmap.width, bitmap.height, PHOTO_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close?.();
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- one plate

async function readPhoto(dataUrl) {
  if (!apiKey) {
    openSheet();
    return;
  }
  if (busy) return;

  busy = true;
  ui.shutter.setAttribute("aria-busy", "true");
  ui.readingPhoto.src = dataUrl;
  showStage("reading");

  try {
    const print = await fingerprint(dataUrl);

    // Never ask about the same photograph twice.
    const known = print.hash ? await findCached(print) : null;
    if (known) {
      showCard(known.card, known.photo || dataUrl, {
        tier: known.tier,
        savedAt: known.savedAt,
        origin: "camera",
        reread: true,
      });
      showStatus("Already in the drawer — nothing was sent.", 4500);
      return;
    }

    const result = await identify({
      apiKey,
      mimeType: "image/jpeg",
      data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    });

    if (result.refusal) {
      showSlip(result.refusal.reason);
      return;
    }

    const tier = rarityFor(result.card.specificity);
    const savedAt = Date.now();
    // Nothing is written yet: the plate is held in memory until the reader
    // decides to keep it, and dropping it costs nothing.
    pendingPlate = { card: result.card, photo: dataUrl, print, tier, savedAt };
    showCard(result.card, dataUrl, { tier, savedAt, origin: "camera", keepable: true });
  } catch (error) {
    showStage("camera");
    showStatus(describe(error), 12000);
  } finally {
    busy = false;
    ui.shutter.removeAttribute("aria-busy");
    updateLedger();
  }
}

/**
 * Store one plate: the album row, and a cached copy so photographing the same
 * thing again is answered without a request. Answers whether it was saved.
 */
async function storePlate(plate) {
  const photo = await shrink(plate.photo, 720);
  const record = {
    hash: plate.print.hash || `t-${plate.savedAt}`,
    v: CARD_VERSION,
    card: plate.card,
    tier: plate.tier,
    photo,
    savedAt: plate.savedAt,
    deviceId: deviceId(),
  };

  if (!(await albumSave({ ...record, id: record.hash }))) return false;
  if (plate.print.hash) {
    await printPut({ hash: plate.print.hash, color: plate.print.color, savedAt: plate.savedAt });
    await cachePut(record);
  }
  return true;
}

/** Keep the plate on screen; until this is tapped, nothing about it was saved. */
async function keepPlate() {
  const plate = pendingPlate;
  if (!plate) return;
  pendingPlate = null;
  ui.keepButton.disabled = true;

  const stored = await storePlate(plate);
  ui.keepButton.hidden = true;
  ui.keepButton.disabled = false;
  await refreshCounts();

  if (stored) {
    showStatus("Kept — it's in the drawer.", 4500);
  } else {
    showStatus("The drawer is full even with the commons cleared, so this plate wasn't kept.", 12000);
  }
}

/**
 * The drawer has no size of its own, so the only ceiling is the browser's
 * storage. Rather than cap the collection, a refused write clears the commons
 * oldest-first — they are the plates easiest to read again — and tries once
 * more for each one dropped.
 */
async function albumSave(record) {
  const dropped = new Set();
  for (;;) {
    if (await albumPut(record)) return true;
    const records = (await albumAll()) || [];
    const victim = records
      .filter(
        (entry) => entry.tier === "common" && entry.id !== record.id && !dropped.has(entry.id),
      )
      .sort((a, b) => a.savedAt - b.savedAt)[0];
    if (!victim) return false;
    dropped.add(victim.id);
    await dropPlate(victim);
  }
}

/** Remove a plate's album row, cached plate, photograph and fingerprint. */
async function dropPlate(record) {
  await albumDelete(record.id);
  if (record.hash) {
    await cacheDelete(record.hash);
    await printDelete(record.hash);
  }
}

async function findCached(print) {
  const prints = (await printsAll()) || [];
  for (const candidate of prints) {
    if (!similar(print, candidate)) continue;
    const record = await cacheGet(candidate.hash);
    if (record?.v === CARD_VERSION) return record;
  }
  return null;
}

function describe(error) {
  if (!(error instanceof IdentifyError)) {
    return "Something went wrong on the way to Gemini. Try once more.";
  }
  const code = error.code || "";
  const detail = error.message && error.message !== `${error.status}` ? ` ${error.message}` : "";

  if (code === "API_KEY_INVALID" || code === "UNAUTHENTICATED" || error.status === 401) {
    return 'Gemini refused the key. Tap "key" and paste a valid one — it needs the Generative Language API enabled.';
  }
  if (code === "PERMISSION_DENIED") {
    return "This key isn't allowed to use that model. Check the key's access in AI Studio.";
  }
  if (code === "RESOURCE_EXHAUSTED" || error.status === 429) {
    return "Gemini says this key's quota is used up for now. Try again later, or use another key.";
  }
  if (code === "NOT_FOUND" || error.status === 404) {
    return "This key can't reach the model on the free tier. Check the key, then try again.";
  }
  if (code === "INVALID_ARGUMENT") {
    return `Gemini rejected the request.${detail}`.trim();
  }
  return `Gemini couldn't answer.${detail}`.trim();
}

// ---------------------------------------------------------------- card

function showCard(card, photo, meta = {}) {
  cardOrigin = meta.origin ?? "camera";
  const tier = meta.tier ?? rarityFor(card.specificity);

  ui.cardPhoto.src = photo;
  ui.frontKind.textContent = card.subjectKind;
  ui.frontDate.textContent = plateDate(meta.savedAt ? new Date(meta.savedAt) : new Date());

  ui.cardStamp.hidden = false;
  ui.cardStamp.className = `stamp stamp--${tier}`;
  ui.stampTier.textContent = tier;

  ui.backKind.textContent = card.subjectKind;
  ui.backName.textContent = plateTitle(card);
  ui.backTech.textContent = card.technicalName;
  ui.backTech.hidden = !card.technicalName;
  // Plates kept before the deeper schema carry an older set of fields, so each
  // block hides itself rather than leaving a labelled hole in the card.
  const definition = card.definition || card.description || "";
  const anatomy = card.anatomy || "";
  const history = Array.isArray(card.history) ? card.history : [];

  ui.backClass.textContent = [card.className, card.origin].filter(Boolean).join(" · ");
  ui.backDef.textContent = definition;
  ui.backAnatomy.textContent = anatomy;
  ui.backWhy.textContent = card.whyItMatters;
  ui.backClosing.textContent = card.closingNote;

  ui.blockWhat.hidden = !definition;
  ui.blockHow.hidden = !anatomy;
  ui.blockHistory.hidden = history.length === 0;
  ui.blockWhy.hidden = !card.whyItMatters;

  ui.backHistory.replaceChildren(
    ...history.map((entry) => {
      const row = document.createElement("li");
      const when = document.createElement("span");
      when.className = "history-when";
      when.textContent = entry.when;
      const what = document.createElement("span");
      what.className = "history-what";
      what.textContent = entry.what;
      row.append(when, what);
      return row;
    }),
  );

  ui.backMeta.replaceChildren(
    metaCell("specificity", card.specificity),
    metaCell("confidence", card.confidence),
  );

  ui.backTags.replaceChildren(
    ...card.tags.map((tag) => {
      const chip = document.createElement("span");
      chip.textContent = tag;
      return chip;
    }),
  );

  const doubts = [];
  if (card.confidence < 60) doubts.push("This identification is uncertain.");
  if (card.subjectKind === "unclear") doubts.push("The subject is hard to make out in the photo.");
  if (meta.reread) doubts.push("Read from the drawer; nothing was scanned again.");
  ui.backUncertain.hidden = doubts.length === 0;
  ui.backUncertain.textContent = doubts.join(" ");

  ui.againButton.textContent = cardOrigin === "album" ? "Back to the drawer" : "New plate";
  ui.keepButton.hidden = !meta.keepable;
  ui.keepButton.disabled = false;
  ui.keepButton.textContent = "Keep";
  setFlipped(false);
  showStage("card");

  const back = ui.card.querySelector(".back-scroll");
  if (back) {
    back.scrollTop = 0;
    ui.card.classList.remove("is-end");
    requestAnimationFrame(() => {
      ui.card.classList.toggle("has-more", back.scrollHeight > back.clientHeight + 8);
    });
  }
}

/** The maker belongs to the name, the way a field guide prints a cultivar. */
function plateTitle(card) {
  const name = card.commonName || "";
  const brand = card.brand || "";
  if (!brand) return name || "Unnamed";
  if (!name) return brand;
  // Some plates already fold the maker into the name; don't say it twice.
  if (name.toLowerCase().startsWith(brand.toLowerCase())) return name;
  return `${brand} ${name}`;
}

function metaCell(label, value) {
  const cell = document.createElement("span");
  const key = document.createElement("span");
  key.textContent = `${label} `;
  const number = document.createElement("span");
  number.textContent = String(value);
  cell.append(key, number);
  return cell;
}

function plateDate(date) {
  const month = date.toLocaleDateString("en-GB", { month: "short" }).toUpperCase();
  return `${date.getDate()} ${month} ${date.getFullYear()}`;
}

function setFlipped(next) {
  flipped = next;
  ui.card.classList.toggle("is-flipped", flipped);
  ui.card.setAttribute(
    "aria-label",
    flipped ? "Card back. Tap to see the photograph." : "Card front. Tap to turn the plate over.",
  );
  ui.turnButton.textContent = flipped ? "Turn back" : "Turn the card";
}

// ---------------------------------------------------------------- album

async function openAlbum() {
  showStage("album");
  ui.statusLine.hidden = true;
  const records = (await albumAll()) || [];
  records.sort(
    (a, b) => (RARITY_RANK[a.tier] ?? 9) - (RARITY_RANK[b.tier] ?? 9) || b.savedAt - a.savedAt,
  );
  ui.albumGrid.replaceChildren(...records.map(albumItem));
  ui.albumEmpty.hidden = records.length > 0;
  await refreshCounts();
}

function albumItem(record) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "album-item";
  item.setAttribute("aria-label", `${record.card.commonName || "Plate"}, ${record.tier}`);

  const thumb = document.createElement("div");
  thumb.className = "album-thumb";

  const img = document.createElement("img");
  img.src = record.photo;
  img.alt = "";
  img.loading = "lazy";

  const stamp = document.createElement("span");
  stamp.className = `stamp stamp--${record.tier}`;
  stamp.textContent = record.tier;

  thumb.append(img, stamp);

  const name = document.createElement("span");
  name.className = "album-name";
  name.textContent = record.card.commonName || "Unnamed";

  const date = document.createElement("span");
  date.className = "album-date";
  date.textContent = plateDate(new Date(record.savedAt));

  item.append(thumb, name, date);
  item.addEventListener("click", () =>
    showCard(record.card, record.photo, {
      tier: record.tier,
      savedAt: record.savedAt,
      origin: "album",
      reread: false,
    }),
  );
  return item;
}

async function refreshCounts() {
  const records = (await albumAll()) || [];
  const counts = { common: 0, notable: 0, rare: 0, singular: 0 };
  for (const record of records) {
    if (record.tier in counts) counts[record.tier] += 1;
  }
  for (const node of document.querySelectorAll(".tier-count[data-tier]")) {
    node.textContent = String(counts[node.dataset.tier] ?? 0).padStart(2, "0");
  }
}

// ---------------------------------------------------------------- refusal

function showSlip(reason) {
  ui.slipReason.textContent = reason || "This one isn't mine to describe.";
  showStage("slip");
}

// ---------------------------------------------------------------- stages

function showStage(name) {
  ui.cameraStage.hidden = name !== "camera";
  ui.readingStage.hidden = name !== "reading";
  ui.cardStage.hidden = name !== "card";
  ui.slipStage.hidden = name !== "slip";
  ui.albumStage.hidden = name !== "album";
  if (name === "camera") updateLedger();
}

function showStatus(message, ms = 5000) {
  ui.statusLine.textContent = message;
  ui.statusLine.hidden = false;
  clearTimeout(statusTimer);
  if (ms > 0) {
    statusTimer = setTimeout(() => {
      ui.statusLine.hidden = true;
    }, ms);
  }
}

// ---------------------------------------------------------------- photo hashing

/**
 * A photograph's fingerprint: a 256-bit difference hash (structure) plus a
 * 4x4 colour grid (hue). Both must agree for a cache hit, because a flat
 * subject — sky, a wall — can give a near-identical grayscale layout.
 */
async function fingerprint(dataUrl) {
  try {
    const image = await loadImage(dataUrl);

    const canvas = document.createElement("canvas");
    canvas.width = 17;
    canvas.height = 16;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, 17, 16);
    const { data } = context.getImageData(0, 0, 17, 16);

    const luminance = (index) =>
      data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;

    let bits = "";
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const left = (y * 17 + x) * 4;
        bits += luminance(left) > luminance(left + 4) ? "1" : "0";
      }
    }

    const swatch = document.createElement("canvas");
    swatch.width = 4;
    swatch.height = 4;
    const swatchContext = swatch.getContext("2d", { willReadFrequently: true });
    swatchContext.drawImage(image, 0, 0, 4, 4);
    const pixels = swatchContext.getImageData(0, 0, 4, 4).data;
    const color = [];
    for (let i = 0; i < pixels.length; i += 4) color.push(pixels[i], pixels[i + 1], pixels[i + 2]);

    return {
      hash: bits.match(/.{4}/g).map((nibble) => parseInt(nibble, 2).toString(16)).join(""),
      color,
    };
  } catch {
    return { hash: "", color: [] };
  }
}

function similar(a, b) {
  if (!a?.hash || !b?.hash || a.hash.length !== b.hash.length) return false;
  if (hamming(a.hash, b.hash) > 6) return false;
  if (!Array.isArray(a.color) || !Array.isArray(b.color) || a.color.length !== b.color.length) {
    return false;
  }
  if (!a.color.length) return false;
  let total = 0;
  for (let i = 0; i < a.color.length; i += 1) total += Math.abs(a.color[i] - b.color[i]);
  return total / a.color.length <= 10;
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 256;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let value = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (value) {
      distance += value & 1;
      value >>= 1;
    }
  }
  return distance;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function shrink(dataUrl, longest) {
  try {
    const image = await loadImage(dataUrl);
    const scale = Math.min(1, longest / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.78);
  } catch {
    return dataUrl;
  }
}

// ---------------------------------------------------------------- key

function readStoredKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function openSheet() {
  ui.keySheet.hidden = false;
  ui.apiKey.value = "";
  ui.closeSheet.hidden = !apiKey;
  ui.keyStatus.textContent = apiKey ? "A key is saved in this browser." : "";
  ui.apiKey.focus({ preventScroll: true });
}

function closeSheet() {
  ui.keySheet.hidden = true;
}

function saveKey() {
  const value = ui.apiKey.value.trim();
  if (!value) {
    ui.keyStatus.textContent = "Paste a key first.";
    return;
  }
  try {
    localStorage.setItem(KEY_STORAGE, value);
  } catch {
    ui.keyStatus.textContent = "This browser won't let me store the key.";
    return;
  }
  apiKey = value;
  ui.apiKey.value = "";
  closeSheet();
  showStage("camera");
  updateLedger();
  showStatus("Key saved in this browser. Point the camera at something.", 4500);
}

function forgetKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* nothing to do */
  }
  apiKey = "";
  ui.apiKey.value = "";
  ui.closeSheet.hidden = true;
  ui.keyStatus.textContent = "Key forgotten.";
  updateLedger();
}

// ---------------------------------------------------------------- events

ui.shutter.addEventListener("click", capture);
ui.pickButton.addEventListener("click", () => ui.fileInput.click());
ui.uploadButton.addEventListener("click", () => ui.fileInput.click());
ui.flashButton.addEventListener("click", toggleFlash);
ui.zoomIn.addEventListener("click", () => applyZoom(zoom + ZOOM_STEP));
ui.zoomOut.addEventListener("click", () => applyZoom(zoom - ZOOM_STEP));
ui.retryCamera.addEventListener("click", startCamera);
ui.albumButton.addEventListener("click", openAlbum);
ui.albumClose.addEventListener("click", () => showStage("camera"));
ui.statusLine.addEventListener("click", () => {
  ui.statusLine.hidden = true;
});

ui.noticeOk.addEventListener("click", () => {
  ui.notice.hidden = true;
  markNoticeSeen();
});

ui.fileInput.addEventListener("change", async () => {
  const file = ui.fileInput.files?.[0];
  ui.fileInput.value = "";
  if (!file) return;
  const photo = await fileToPhoto(file);
  if (photo) await readPhoto(photo);
  else showStatus("I couldn't read that file. Try another photo.", 6000);
});

// Tap to turn the card, but ignore the tap that ends a scroll on the back.
let pressAt = null;
ui.card.addEventListener("pointerdown", (event) => {
  pressAt = { x: event.clientX, y: event.clientY };
});
ui.card.addEventListener("pointerup", (event) => {
  if (!pressAt) return;
  const moved = Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y);
  pressAt = null;
  if (moved < 8) setFlipped(!flipped);
});
ui.card.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setFlipped(!flipped);
  }
});

// The "more" bar points down the plate; once the end is reached it steps aside.
const backScroll = document.querySelector(".back-scroll");
backScroll?.addEventListener("scroll", () => {
  const atEnd = backScroll.scrollTop + backScroll.clientHeight >= backScroll.scrollHeight - 8;
  ui.card.classList.toggle("is-end", atEnd);
});

ui.turnButton.addEventListener("click", () => setFlipped(!flipped));
ui.keepButton.addEventListener("click", keepPlate);
ui.againButton.addEventListener("click", () => {
  // Leaving without keeping drops the plate; it was never written anywhere.
  pendingPlate = null;
  if (cardOrigin === "album") {
    openAlbum();
    return;
  }
  showStage("camera");
  startCamera();
});

ui.slipBack.addEventListener("click", () => showStage("camera"));

ui.keyButton.addEventListener("click", openSheet);
ui.saveKey.addEventListener("click", saveKey);
ui.forgetKey.addEventListener("click", forgetKey);
ui.closeSheet.addEventListener("click", closeSheet);
ui.apiKey.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveKey();
});
