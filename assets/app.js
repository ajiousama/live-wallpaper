const MODULE_LABELS = {
  jr_matsuyama: "JR松山駅",
  ichitsubo: "JR市坪駅",
  airport: "松山空港",
  airport_bus: "空港バス",
  highway_bus: "高速・中距離バス",
  ferry: "フェリー"
};

function tickClock() {
  const now = new Date();
  document.getElementById("clock").textContent =
    new Intl.DateTimeFormat("ja-JP",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(now);
  document.getElementById("date").textContent =
    new Intl.DateTimeFormat("ja-JP",{year:"numeric",month:"2-digit",day:"2-digit",weekday:"short"}).format(now);
}

function renderModules(modules) {
  const root = document.getElementById("modules");
  root.replaceChildren();
  for (const [key,label] of Object.entries(MODULE_LABELS)) {
    const info = modules?.[key] || {status:"waiting",detail:"取得処理未接続"};
    const card = document.createElement("article");
    card.className = "card";
    const h2 = document.createElement("h2");
    h2.textContent = label;
    const state = document.createElement("div");
    state.className = "state";
    state.textContent = info.status === "ok" ? "取得中" : info.status === "error" ? "エラー" : "準備中";
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = info.detail || "";
    card.append(h2,state,detail);
    root.append(card);
  }
}

async function refreshStatus() {
  const dot = document.getElementById("health-dot");
  const health = document.getElementById("health");
  try {
    const res = await fetch("data/status.json?t="+Date.now(),{cache:"no-store"});
    if (!res.ok) throw new Error("HTTP "+res.status);
    const data = await res.json();
    document.getElementById("updated").textContent = data.generated_at_jst || "--";
    dot.className = "dot ok";
    health.textContent = "GitHubデータ正常";
    renderModules(data.modules);
  } catch (e) {
    dot.className = "dot warn";
    health.textContent = "GitHubデータ取得失敗";
  }
}

tickClock();
setInterval(tickClock,1000);
refreshStatus();
setInterval(refreshStatus,60000);
