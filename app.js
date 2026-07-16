// 카카오 비즈보드 아카이브 - Supabase(공유 DB + Storage)에 이미지+메타데이터 저장, 팀원 전체가 같은 데이터를 봄

const SUPABASE_URL = "https://cpvnppnboeqdlrnmgtmu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNwdm5wcG5ib2VxZGxybm1ndG11Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0NjA0MzQsImV4cCI6MjA5OTAzNjQzNH0.Qa_sA1G_qkldfTBpS2BObjBjhDhHxMJqXVc7tzY6Hf4";
const IMAGE_BUCKET = "ad-images";
let supabaseClient;
let currentImageDataUrl = null; // pending upload for add/edit modal
let editingId = null;

// OCR로 텍스트만 뽑고, 알려진 브랜드명이 텍스트에 포함되어 있으면 브랜드를 추정한다.
// 로고만 있고 텍스트가 없는 경우, 또는 목록에 없는 브랜드는 인식하지 못하므로 항상 수동 확인이 필요하다.
const KNOWN_BRANDS = [
  "올리브영", "무신사", "지그재그", "에이블리", "브랜디", "화해",
  "패스트캠퍼스", "덧셈", "아정당", "세이브앤택스", "스파르타", "자리톡", 
  "쿠팡", "컬리", "마켓컬리", "11번가", "지마켓", "G마켓", "다이소", "하이마트",
  "배달의민족", "배민", "요기요", "쿠팡이츠",
  "토스", "카카오뱅크", "카카오페이", "신한카드", "삼성카드", "뱅크샐러드", "핀다", "토스증권",
  "야놀자", "여기어때", "트리플", "마이리얼트립", "클룩",
  "리니지", "오딘", "우마무스메", "넷마블", "넥슨", "라이온하트",
  "메가스터디", "해커스", "야나두", "클래스101", "콴다", "시원스쿨", "스픽",
  "당근마켓", "당근", "오늘의집",
  "직방", "다방",
  "원티드", "잡코리아", "사람인", "리멤버",
  "카카오T", "카카오모빌리티", "타다", "쏘카", "그린카", 
];

function guessFromOcrText(text) {
  const result = { brand: "", copyText: "" };
  if (!text) return result;

  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 2);

  result.brand = KNOWN_BRANDS.find((brand) => text.includes(brand)) || "";

  // 카피는 보통 2줄 이내로 나뉘어 있으므로, 브랜드명 줄을 제외한 가장 긴 두 줄을
  // 원래 등장 순서대로 이어붙인다.
  const topLines = lines
    .filter((l) => l !== result.brand)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
  result.copyText = lines.filter((l) => topLines.includes(l)).join(" ");

  return result;
}

// 배너 광고는 해상도가 낮고 대비가 흐린 경우가 많아, 확대 + 흑백 대비 강조를 거치면
// Tesseract 인식률이 눈에 띄게 좋아진다.
function preprocessImageForOcr(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = img.width < 600 ? 2 : 1;
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        const contrasted = Math.min(255, Math.max(0, (gray - 128) * 1.3 + 128));
        d[i] = d[i + 1] = d[i + 2] = contrasted;
      }
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function runOcrAutoFill(dataUrl) {
  const statusEl = document.getElementById("ocrStatus");
  if (typeof Tesseract === "undefined") {
    statusEl.hidden = true;
    return;
  }
  statusEl.hidden = false;
  statusEl.classList.add("working");
  statusEl.textContent = "이미지에서 텍스트 인식 중... (첫 실행 시 시간이 더 걸릴 수 있어요)";

  let worker = null;
  try {
    const preprocessed = await preprocessImageForOcr(dataUrl);
    worker = await Tesseract.createWorker("kor+eng");
    // 배너 광고는 로고/카피/버튼 문구가 흩어져 있는 경우가 많아 sparse text 모드가 더 잘 맞는다.
    await worker.setParameters({ tessedit_pageseg_mode: "11" });
    const { data: { text } } = await worker.recognize(preprocessed);
    const guess = guessFromOcrText(text);

    const brandInput = document.getElementById("inBrand");
    const copyInput = document.getElementById("inCopy");

    if (guess.brand && !brandInput.value) brandInput.value = guess.brand;
    if (guess.copyText && !copyInput.value) copyInput.value = guess.copyText;

    statusEl.classList.remove("working");
    statusEl.textContent = (guess.brand || guess.copyText)
      ? "자동 인식 완료 — 내용을 확인하고 필요하면 수정해주세요."
      : "텍스트를 인식하지 못했어요. 직접 입력해주세요.";
  } catch (err) {
    statusEl.classList.remove("working");
    statusEl.textContent = "자동 인식에 실패했어요. 직접 입력해주세요.";
  } finally {
    if (worker) await worker.terminate();
  }
}

// 업로드한 원본 파일이 GIF였는지 기억해서, 크롭 후에도 "영상형" 자동 판단에 쓴다.
let pendingIsAnimated = false;

function loadImageEl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function guessSizeFromDimensions(width, height) {
  const ratio = width / height;
  if (ratio > 1.15) return "가로";
  if (ratio < 0.87) return "세로";
  return "정방형";
}

// 배경이 단조로우면(한 색이 화면 대부분을 차지) 아이콘/오브젝트가 얹힌 오브젝트형,
// 색이 다양하게 퍼져 있으면 풀 이미지인 이미지형으로 추정한다. 어디까지나 대략적인 추정이라
// 실제로는 반드시 확인이 필요하다.
function guessFormatFromImage(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  const step = Math.max(1, Math.floor(Math.min(width, height) / 60));
  const colorCounts = new Map();
  let total = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
      colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
      total++;
    }
  }
  if (!total) return "";
  const maxCount = Math.max(...colorCounts.values());
  return maxCount / total > 0.5 ? "오브젝트형" : "이미지형";
}

async function autoFillFromImageMeta(dataUrl) {
  const sizeInput = document.getElementById("inSize");
  const formatInput = document.getElementById("inFormat");
  try {
    const img = await loadImageEl(dataUrl);
    if (!sizeInput.value) sizeInput.value = guessSizeFromDimensions(img.width, img.height);
    if (!formatInput.value) {
      formatInput.value = pendingIsAnimated ? "영상형" : guessFormatFromImage(img);
    }
  } catch (err) {
    // 인식 실패 시 조용히 넘어가고 수동 선택을 유도한다.
  }
}

function initSupabase() {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function rowToAd(row) {
  return {
    id: row.id,
    image: row.image,
    brand: row.brand,
    size: row.size,
    media: row.media,
    format: row.format,
    date: row.date,
    copyText: row.copy_text,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

function adToRow(ad) {
  return {
    id: ad.id,
    image: ad.image,
    brand: ad.brand,
    size: ad.size,
    media: ad.media,
    format: ad.format,
    date: ad.date,
    copy_text: ad.copyText,
    memo: ad.memo,
    created_at: ad.createdAt,
  };
}

async function dbGetAll() {
  const { data, error } = await supabaseClient.from("ads").select("*");
  if (error) throw error;
  return data.map(rowToAd);
}

async function dbPut(record) {
  const { error } = await supabaseClient.from("ads").upsert(adToRow(record));
  if (error) throw error;
}

async function dbDelete(id) {
  const { error } = await supabaseClient.from("ads").delete().eq("id", id);
  if (error) throw error;
  // 이미지도 같이 정리한다 (없어도 조용히 무시).
  await supabaseClient.storage.from(IMAGE_BUCKET).remove([`${id}.png`]);
}

async function uploadImage(dataUrl, id) {
  const blob = await (await fetch(dataUrl)).blob();
  const path = `${id}.png`;
  const { error } = await supabaseClient.storage
    .from(IMAGE_BUCKET)
    .upload(path, blob, { contentType: "image/png", upsert: true });
  if (error) throw error;
  const { data } = supabaseClient.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function uid() {
  return "ad_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------- state ----------
let allAds = [];

async function refresh() {
  try {
    allAds = await dbGetAll();
    renderGallery();
  } catch (err) {
    const empty = document.getElementById("emptyState");
    document.getElementById("gallery").innerHTML = "";
    document.getElementById("resultCount").textContent = "0";
    empty.hidden = false;
    empty.textContent = "데이터를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침 해주세요.";
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getFilters() {
  return {
    search: document.getElementById("fSearch").value.trim().toLowerCase(),
    media: document.getElementById("fMedia").value,
    size: document.getElementById("fSize").value,
    dateFrom: document.getElementById("fDateFrom").value,
    dateTo: document.getElementById("fDateTo").value,
    sort: document.getElementById("fSort").value,
  };
}

function applyFilters(ads, f) {
  let out = ads.filter((a) => {
    if (f.search) {
      const hay = [a.brand, a.copyText, a.memo].join(" ").toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    if (f.media && a.media !== f.media) return false;
    if (f.size && a.size !== f.size) return false;
    if (f.dateFrom && a.date && a.date < f.dateFrom) return false;
    if (f.dateTo && a.date && a.date > f.dateTo) return false;
    return true;
  });

  out.sort((a, b) => {
    if (f.sort === "dateAsc") return (a.date || "").localeCompare(b.date || "");
    if (f.sort === "brand") return (a.brand || "").localeCompare(b.brand || "", "ko");
    return (b.date || "").localeCompare(a.date || "") || (b.createdAt - a.createdAt);
  });

  return out;
}

function renderGallery() {
  const f = getFilters();
  const filtered = applyFilters(allAds, f);
  const gallery = document.getElementById("gallery");
  const empty = document.getElementById("emptyState");

  document.getElementById("resultCount").textContent = filtered.length;

  if (filtered.length === 0) {
    gallery.innerHTML = "";
    empty.hidden = false;
    empty.textContent = allAds.length === 0
      ? '아직 저장된 광고가 없습니다. 오른쪽 위의 "+ 광고 추가"로 스크린샷을 업로드해보세요.'
      : "필터 조건에 맞는 광고가 없습니다.";
    return;
  }
  empty.hidden = true;

  gallery.innerHTML = filtered.map((a) => `
    <div class="card" data-id="${a.id}">
      <img class="card-thumb" src="${a.image}" alt="${escapeHtml(a.brand)}" />
      <div class="card-body">
        <p class="card-brand">${escapeHtml(a.brand) || "(브랜드 미입력)"}</p>
        <div class="card-tags">
          ${a.media ? `<span class="tag media">${escapeHtml(a.media)}</span>` : ""}
          ${a.size ? `<span class="tag size">${escapeHtml(a.size)}</span>` : ""}
          ${a.format ? `<span class="tag format">${escapeHtml(a.format)}</span>` : ""}
        </div>
        <p class="card-date">${a.date || ""}</p>
      </div>
    </div>
  `).join("");

  gallery.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => openDetail(card.dataset.id));
  });
}

// ---------- Add/Edit modal ----------
const modalBackdrop = document.getElementById("modalBackdrop");
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const previewImg = document.getElementById("previewImg");
const dropZoneText = document.getElementById("dropZoneText");

function resetForm() {
  editingId = null;
  currentImageDataUrl = null;
  previewImg.hidden = true;
  previewImg.src = "";
  dropZoneText.hidden = false;
  dropZone.hidden = false;
  document.getElementById("btnRecrop").hidden = true;
  closeCropStage();
  pendingIsAnimated = false;
  document.getElementById("inBrand").value = "";
  document.getElementById("inSize").value = "";
  document.getElementById("inMedia").value = "";
  document.getElementById("inFormat").value = "";
  document.getElementById("inDate").value = new Date().toISOString().slice(0, 10);
  document.getElementById("inCopy").value = "";
  document.getElementById("inMemo").value = "";
  document.getElementById("btnDelete").hidden = true;
  document.getElementById("modalTitle").textContent = "광고 추가";
  const statusEl = document.getElementById("ocrStatus");
  statusEl.hidden = true;
  statusEl.classList.remove("working");
}

function openAddModal() {
  resetForm();
  modalBackdrop.hidden = false;
}

function openEditModal(ad) {
  resetForm();
  editingId = ad.id;
  currentImageDataUrl = ad.image;
  previewImg.src = ad.image;
  previewImg.hidden = false;
  dropZoneText.hidden = true;
  document.getElementById("btnRecrop").hidden = false;
  document.getElementById("inBrand").value = ad.brand || "";
  document.getElementById("inSize").value = ad.size || "";
  document.getElementById("inMedia").value = ad.media || "";
  document.getElementById("inFormat").value = ad.format || "";
  document.getElementById("inDate").value = ad.date || "";
  document.getElementById("inCopy").value = ad.copyText || "";
  document.getElementById("inMemo").value = ad.memo || "";
  document.getElementById("btnDelete").hidden = false;
  document.getElementById("modalTitle").textContent = "광고 수정";
  modalBackdrop.hidden = false;
}

function closeModal() {
  modalBackdrop.hidden = true;
}

function finalizeImage(dataUrl) {
  currentImageDataUrl = dataUrl;
  previewImg.src = dataUrl;
  previewImg.hidden = false;
  dropZoneText.hidden = true;
  dropZone.hidden = false;
  document.getElementById("btnRecrop").hidden = false;
  autoFillFromImageMeta(dataUrl);
  runOcrAutoFill(dataUrl);
}

// ---------- Crop ----------
const cropStage = document.getElementById("cropStage");
const cropImage = document.getElementById("cropImage");
let cropper = null;

function openCropStage(dataUrl) {
  dropZone.hidden = true;
  document.getElementById("btnRecrop").hidden = true;
  cropStage.hidden = false;
  cropImage.src = dataUrl;

  if (cropper) { cropper.destroy(); cropper = null; }

  if (typeof Cropper === "undefined") {
    // 크롭 라이브러리가 아직 로드되지 않았으면 크롭 없이 바로 사용
    closeCropStage();
    finalizeImage(dataUrl);
    return;
  }

  cropper = new Cropper(cropImage, { viewMode: 1, autoCropArea: 1, background: false });
}

function closeCropStage() {
  cropStage.hidden = true;
  if (cropper) { cropper.destroy(); cropper = null; }
}

document.getElementById("btnCropApply").addEventListener("click", () => {
  if (!cropper) return;
  const canvas = cropper.getCroppedCanvas();
  const dataUrl = canvas ? canvas.toDataURL("image/png") : cropImage.src;
  closeCropStage();
  finalizeImage(dataUrl);
});

document.getElementById("btnCropSkip").addEventListener("click", () => {
  const dataUrl = cropImage.src;
  closeCropStage();
  finalizeImage(dataUrl);
});

document.getElementById("btnRecrop").addEventListener("click", () => {
  if (!currentImageDataUrl) return;
  openCropStage(currentImageDataUrl);
});

function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  pendingIsAnimated = file.type === "image/gif";
  const reader = new FileReader();
  reader.onload = () => openCropStage(reader.result);
  reader.readAsDataURL(file);
}

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));

dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  handleFile(e.dataTransfer.files[0]);
});

document.addEventListener("paste", (e) => {
  if (modalBackdrop.hidden) return;
  // 브랜드/카피 등 텍스트 필드를 고치는 중에 클립보드에 예전 이미지가 남아있으면
  // 텍스트를 붙여넣으려 한 건데도 이미지 붙여넣기로 오인해 크롭 화면으로 튕기게 된다.
  // 텍스트 입력창에 포커스가 있을 때는 이미지 자동 붙여넣기를 건너뛴다.
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      handleFile(item.getAsFile());
      break;
    }
  }
});

document.getElementById("btnAdd").addEventListener("click", openAddModal);
document.getElementById("btnCloseModal").addEventListener("click", closeModal);
document.getElementById("btnCancel").addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) closeModal(); });

document.getElementById("btnSave").addEventListener("click", async () => {
  if (!currentImageDataUrl) {
    alert("이미지를 먼저 업로드해주세요.");
    return;
  }
  const record = {
    id: editingId || uid(),
    image: currentImageDataUrl,
    brand: document.getElementById("inBrand").value.trim(),
    size: document.getElementById("inSize").value,
    media: document.getElementById("inMedia").value,
    format: document.getElementById("inFormat").value,
    date: document.getElementById("inDate").value,
    copyText: document.getElementById("inCopy").value.trim(),
    memo: document.getElementById("inMemo").value.trim(),
    createdAt: editingId ? (allAds.find((a) => a.id === editingId)?.createdAt || Date.now()) : Date.now(),
  };

  const btnSave = document.getElementById("btnSave");
  btnSave.disabled = true;
  btnSave.textContent = "저장 중...";
  try {
    if (record.image.startsWith("data:")) {
      record.image = await uploadImage(record.image, record.id);
    }
    await dbPut(record);
    closeModal();
    await refresh();
  } catch (err) {
    alert("저장에 실패했어요. 인터넷 연결을 확인하고 다시 시도해주세요.");
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = "저장";
  }
});

document.getElementById("btnDelete").addEventListener("click", async () => {
  if (!editingId) return;
  if (!confirm("이 광고를 삭제할까요?")) return;
  try {
    await dbDelete(editingId);
    closeModal();
    await refresh();
  } catch (err) {
    alert("삭제에 실패했어요. 인터넷 연결을 확인하고 다시 시도해주세요.");
  }
});

// ---------- Detail modal ----------
const detailBackdrop = document.getElementById("detailBackdrop");
let detailAdId = null;

function openDetail(id) {
  const ad = allAds.find((a) => a.id === id);
  if (!ad) return;
  detailAdId = id;
  document.getElementById("detailTitle").textContent = ad.brand || "(브랜드 미입력)";
  document.getElementById("detailImg").src = ad.image;
  const meta = document.getElementById("detailMeta");
  const rows = [
    ["소재 사이즈", ad.size],
    ["매체", ad.media],
    ["소재 형식", ad.format],
    ["캡처 날짜", ad.date],
    ["카피 문구", ad.copyText],
    ["메모", ad.memo],
  ];
  meta.innerHTML = rows.filter(([, v]) => v).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
  detailBackdrop.hidden = false;
}

document.getElementById("btnCloseDetail").addEventListener("click", () => (detailBackdrop.hidden = true));
detailBackdrop.addEventListener("click", (e) => { if (e.target === detailBackdrop) detailBackdrop.hidden = true; });

document.getElementById("btnDetailEdit").addEventListener("click", () => {
  const ad = allAds.find((a) => a.id === detailAdId);
  detailBackdrop.hidden = true;
  if (ad) openEditModal(ad);
});

document.getElementById("btnDetailDelete").addEventListener("click", async () => {
  if (!detailAdId) return;
  if (!confirm("이 광고를 삭제할까요?")) return;
  try {
    await dbDelete(detailAdId);
    detailBackdrop.hidden = true;
    await refresh();
  } catch (err) {
    alert("삭제에 실패했어요. 인터넷 연결을 확인하고 다시 시도해주세요.");
  }
});

document.getElementById("btnDetailDownload").addEventListener("click", async () => {
  const ad = allAds.find((a) => a.id === detailAdId);
  if (!ad || !ad.image) return;
  const btn = document.getElementById("btnDetailDownload");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "다운로드 중...";
  try {
    const res = await fetch(ad.image);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `${ad.brand || "ad"}_${ad.date || ""}.png`.replace(/\s+/g, "_");
    a.click();
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    alert("다운로드에 실패했어요.");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// ---------- Filters ----------
["fSearch", "fMedia", "fSize", "fDateFrom", "fDateTo", "fSort"].forEach((id) => {
  document.getElementById(id).addEventListener("input", renderGallery);
  document.getElementById(id).addEventListener("change", renderGallery);
});

document.getElementById("btnResetFilter").addEventListener("click", () => {
  document.getElementById("fSearch").value = "";
  document.getElementById("fMedia").value = "";
  document.getElementById("fSize").value = "";
  document.getElementById("fDateFrom").value = "";
  document.getElementById("fDateTo").value = "";
  document.getElementById("fSort").value = "dateDesc";
  renderGallery();
});

document.getElementById("btnRefresh").addEventListener("click", refresh);

// ---------- Keyboard ----------
document.addEventListener("keydown", (e) => {
  // 한글 등 IME로 글자를 조합하는 중에 오타를 취소하려고 누른 Escape까지
  // 여기서 잡아버리면 입력 중이던 팝업이 그대로 닫혀버린다. 조합 중인 Escape는 무시한다.
  if (e.key === "Escape" && !e.isComposing) {
    if (!modalBackdrop.hidden) closeModal();
    if (!detailBackdrop.hidden) detailBackdrop.hidden = true;
  }
});

// ---------- Init ----------
(async function init() {
  initSupabase();
  await refresh();
})();
