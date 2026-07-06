// 카카오 비즈보드 아카이브 - 로컬 전용 (IndexedDB에 이미지+메타데이터 저장)

const DB_NAME = "bizboard-archive";
const STORE = "ads";
let db;
let currentImageDataUrl = null; // pending upload for add/edit modal
let editingId = null;

// OCR로 텍스트만 뽑고, 알려진 브랜드명이 텍스트에 포함되어 있으면 브랜드/업종을 추정한다.
// 로고만 있고 텍스트가 없는 경우, 또는 목록에 없는 브랜드는 인식하지 못하므로 항상 수동 확인이 필요하다.
const BRAND_CATEGORY_MAP = {
  "올리브영": "뷰티", "무신사": "패션", "지그재그": "패션", "에이블리": "패션", "브랜디": "패션",
  "쿠팡": "이커머스", "컬리": "이커머스", "마켓컬리": "이커머스", "11번가": "이커머스", "지마켓": "이커머스", "G마켓": "이커머스",
  "배달의민족": "F&B", "배민": "F&B", "요기요": "F&B", "쿠팡이츠": "F&B",
  "토스": "금융", "카카오뱅크": "금융", "카카오페이": "금융", "신한카드": "금융", "삼성카드": "금융", "뱅크샐러드": "금융", "핀다": "금융",
  "야놀자": "여행", "여기어때": "여행", "트리플": "여행", "마이리얼트립": "여행", "클룩": "여행",
  "리니지": "게임", "오딘": "게임", "우마무스메": "게임", "넷마블": "게임", "넥슨": "게임", "라이온하트": "게임",
  "메가스터디": "교육", "해커스": "교육", "야나두": "교육", "클래스101": "교육",
  "당근마켓": "이커머스", "당근": "이커머스",
};

const CATEGORY_KEYWORDS = {
  "뷰티": ["스킨", "화장품", "크림", "앰플", "선크림", "파운데이션", "클렌징"],
  "패션": ["원피스", "신발", "가방", "코디", "룩북", "니트"],
  "게임": ["사전예약", "레벨업", "길드", "전투", "캐릭터", "출시"],
  "금융": ["적금", "대출", "환전", "이자", "카드발급", "재테크", "투자"],
  "이커머스": ["최저가", "특가", "쿠폰", "배송", "로켓배송", "타임세일"],
  "교육": ["강의", "인강", "수강", "합격", "자격증"],
  "여행": ["항공권", "호텔", "숙소", "예약", "여행자보험"],
  "F&B": ["맛집", "배달", "주문", "할인쿠폰", "1인분"],
  "헬스케어": ["병원", "다이어트", "영양제", "건강검진", "비대면진료"],
};

function guessFromOcrText(text) {
  const result = { brand: "", category: "", copyText: "" };
  if (!text) return result;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length) {
    result.copyText = lines.reduce((a, b) => (b.length > a.length ? b : a), lines[0]);
  }

  for (const [brand, category] of Object.entries(BRAND_CATEGORY_MAP)) {
    if (text.includes(brand)) {
      result.brand = brand;
      result.category = category;
      break;
    }
  }

  if (!result.category) {
    let bestCategory = "";
    let bestScore = 0;
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      const score = keywords.filter((k) => text.includes(k)).length;
      if (score > bestScore) { bestScore = score; bestCategory = category; }
    }
    if (bestScore > 0) result.category = bestCategory;
  }

  return result;
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

  try {
    const { data: { text } } = await Tesseract.recognize(dataUrl, "kor+eng");
    const guess = guessFromOcrText(text);

    const brandInput = document.getElementById("inBrand");
    const categoryInput = document.getElementById("inCategory");
    const copyInput = document.getElementById("inCopy");

    if (guess.brand && !brandInput.value) brandInput.value = guess.brand;
    if (guess.category && !categoryInput.value) categoryInput.value = guess.category;
    if (guess.copyText && !copyInput.value) copyInput.value = guess.copyText;

    statusEl.classList.remove("working");
    statusEl.textContent = (guess.brand || guess.category || guess.copyText)
      ? "자동 인식 완료 — 내용을 확인하고 필요하면 수정해주세요."
      : "텍스트를 인식하지 못했어요. 직접 입력해주세요.";
  } catch (err) {
    statusEl.classList.remove("working");
    statusEl.textContent = "자동 인식에 실패했어요. 직접 입력해주세요.";
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const _db = req.result;
      if (!_db.objectStoreNames.contains(STORE)) {
        const store = _db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("brand", "brand", { unique: false });
        store.createIndex("category", "category", { unique: false });
        store.createIndex("date", "date", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txStore(mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function dbGetAll() {
  return new Promise((resolve, reject) => {
    const req = txStore("readonly").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(record) {
  return new Promise((resolve, reject) => {
    const req = txStore("readwrite").put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const req = txStore("readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function uid() {
  return "ad_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------- state ----------
let allAds = [];

async function refresh() {
  allAds = await dbGetAll();
  populateCategoryFilter();
  renderGallery();
}

function populateCategoryFilter() {
  const sel = document.getElementById("fCategory");
  const current = sel.value;
  const cats = Array.from(new Set(allAds.map((a) => a.category).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">업종 전체</option>' + cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  sel.value = current;
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getFilters() {
  return {
    search: document.getElementById("fSearch").value.trim().toLowerCase(),
    category: document.getElementById("fCategory").value,
    age: document.getElementById("fAge").value,
    gender: document.getElementById("fGender").value,
    dateFrom: document.getElementById("fDateFrom").value,
    dateTo: document.getElementById("fDateTo").value,
    sort: document.getElementById("fSort").value,
  };
}

function applyFilters(ads, f) {
  let out = ads.filter((a) => {
    if (f.search) {
      const hay = [a.brand, a.copyText, a.memo, a.source].join(" ").toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    if (f.category && a.category !== f.category) return false;
    if (f.age && !(a.targetAge || []).includes(f.age)) return false;
    if (f.gender && a.targetGender !== f.gender) return false;
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
          ${a.category ? `<span class="tag category">${escapeHtml(a.category)}</span>` : ""}
          ${(a.targetAge || []).map((t) => `<span class="tag age">${escapeHtml(t)}</span>`).join("")}
          ${a.targetGender ? `<span class="tag gender">${escapeHtml(a.targetGender)}</span>` : ""}
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
  document.getElementById("inBrand").value = "";
  document.getElementById("inCategory").value = "";
  document.getElementById("inFormat").value = "오브젝트형";
  document.getElementById("inDate").value = new Date().toISOString().slice(0, 10);
  document.getElementById("inGender").value = "전체/불명";
  document.getElementById("inRegion").value = "";
  document.getElementById("inSource").value = "";
  document.getElementById("inCopy").value = "";
  document.getElementById("inMemo").value = "";
  document.querySelectorAll('.fieldset-inline input[type="checkbox"]').forEach((c) => (c.checked = false));
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
  document.getElementById("inBrand").value = ad.brand || "";
  document.getElementById("inCategory").value = ad.category || "";
  document.getElementById("inFormat").value = ad.format || "오브젝트형";
  document.getElementById("inDate").value = ad.date || "";
  document.getElementById("inGender").value = ad.targetGender || "전체/불명";
  document.getElementById("inRegion").value = ad.region || "";
  document.getElementById("inSource").value = ad.source || "";
  document.getElementById("inCopy").value = ad.copyText || "";
  document.getElementById("inMemo").value = ad.memo || "";
  (ad.targetAge || []).forEach((val) => {
    const el = document.querySelector(`.fieldset-inline input[value="${val}"]`);
    if (el) el.checked = true;
  });
  document.getElementById("btnDelete").hidden = false;
  document.getElementById("modalTitle").textContent = "광고 수정";
  modalBackdrop.hidden = false;
}

function closeModal() {
  modalBackdrop.hidden = true;
}

function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    currentImageDataUrl = reader.result;
    previewImg.src = currentImageDataUrl;
    previewImg.hidden = false;
    dropZoneText.hidden = true;
    runOcrAutoFill(currentImageDataUrl);
  };
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
  const targetAge = Array.from(document.querySelectorAll('.fieldset-inline input[type="checkbox"]:checked')).map((c) => c.value);

  const record = {
    id: editingId || uid(),
    image: currentImageDataUrl,
    brand: document.getElementById("inBrand").value.trim(),
    category: document.getElementById("inCategory").value.trim(),
    format: document.getElementById("inFormat").value,
    date: document.getElementById("inDate").value,
    targetAge,
    targetGender: document.getElementById("inGender").value,
    region: document.getElementById("inRegion").value.trim(),
    source: document.getElementById("inSource").value.trim(),
    copyText: document.getElementById("inCopy").value.trim(),
    memo: document.getElementById("inMemo").value.trim(),
    createdAt: editingId ? (allAds.find((a) => a.id === editingId)?.createdAt || Date.now()) : Date.now(),
  };

  await dbPut(record);
  closeModal();
  await refresh();
});

document.getElementById("btnDelete").addEventListener("click", async () => {
  if (!editingId) return;
  if (!confirm("이 광고를 삭제할까요?")) return;
  await dbDelete(editingId);
  closeModal();
  await refresh();
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
    ["업종", ad.category],
    ["소재 형식", ad.format],
    ["캡처 날짜", ad.date],
    ["타깃 연령", (ad.targetAge || []).join(", ")],
    ["타깃 성별", ad.targetGender],
    ["지역", ad.region],
    ["캡처 계정/기기", ad.source],
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
  await dbDelete(detailAdId);
  detailBackdrop.hidden = true;
  await refresh();
});

// ---------- Filters ----------
["fSearch", "fCategory", "fAge", "fGender", "fDateFrom", "fDateTo", "fSort"].forEach((id) => {
  document.getElementById(id).addEventListener("input", renderGallery);
  document.getElementById(id).addEventListener("change", renderGallery);
});

document.getElementById("btnResetFilter").addEventListener("click", () => {
  document.getElementById("fSearch").value = "";
  document.getElementById("fCategory").value = "";
  document.getElementById("fAge").value = "";
  document.getElementById("fGender").value = "";
  document.getElementById("fDateFrom").value = "";
  document.getElementById("fDateTo").value = "";
  document.getElementById("fSort").value = "dateDesc";
  renderGallery();
});

// ---------- Export / Import ----------
document.getElementById("btnExport").addEventListener("click", async () => {
  const ads = await dbGetAll();
  const blob = new Blob([JSON.stringify(ads, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bizboard-archive-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const records = JSON.parse(text);
    if (!Array.isArray(records)) throw new Error("invalid format");
    for (const r of records) {
      if (r.id && r.image) await dbPut(r);
    }
    await refresh();
    alert(`${records.length}개 항목을 가져왔습니다.`);
  } catch (err) {
    alert("가져오기 실패: 올바른 백업 파일인지 확인해주세요.");
  } finally {
    e.target.value = "";
  }
});

// ---------- Keyboard ----------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!modalBackdrop.hidden) closeModal();
    if (!detailBackdrop.hidden) detailBackdrop.hidden = true;
  }
});

// ---------- Init ----------
(async function init() {
  db = await openDb();
  await refresh();
})();
