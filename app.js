"use strict";
/* AgentPay frontend — plain static JS, ethers v6 (UMD global `ethers`). */

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const $ = (s, el) => (el || document).querySelector(s);
const ZERO = "0x0000000000000000000000000000000000000000";
const CONFIGURED = !!CONFIG.CONTRACT_ADDRESS && CONFIG.CONTRACT_ADDRESS.toLowerCase() !== ZERO;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function dispHandle(h) { return h ? esc(h) + ".ai" : "agent"; }
function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(Number(ts) * 1000).toLocaleString(undefined,
    { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function txLink(hash) {
  return `<a href="${CONFIG.EXPLORER}/tx/${hash}" target="_blank" rel="noopener">view tx</a>`;
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "on" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, 5200);
}

/* ------------------------------------------------------------------ */
/* Read access (public RPC, with fallback)                             */
/* ------------------------------------------------------------------ */
let _providers = null;
function readProviders() {
  if (!_providers) _providers = CONFIG.RPCS.map((u) => new ethers.JsonRpcProvider(u, CONFIG.CHAIN_ID));
  return _providers;
}
async function readCall(fn) {
  let lastErr = null;
  for (const p of readProviders()) {
    try { return await fn(p); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const readContract = (p) => new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONTRACT_ABI, p);
const registryRead = (p) => new ethers.Contract(CONFIG.REGISTRY_ADDRESS, REGISTRY_ABI, p);

/* Token metadata (symbol / decimals), cached. BNB = the zero address. */
const _tokenMeta = new Map();
async function tokenMeta(addr) {
  if (!addr || addr.toLowerCase() === ZERO) return { symbol: "BNB", decimals: 18 };
  const key = addr.toLowerCase();
  if (_tokenMeta.has(key)) return _tokenMeta.get(key);
  let meta = { symbol: "TOKEN", decimals: 18 };
  try {
    const c = new ethers.Contract(addr, ERC20_ABI, readProviders()[0]);
    const [sym, dec] = await Promise.all([
      c.symbol().catch(() => "TOKEN"),
      c.decimals().catch(() => 18)
    ]);
    meta = { symbol: String(sym), decimals: Number(dec) };
  } catch (e) { /* keep defaults */ }
  _tokenMeta.set(key, meta);
  return meta;
}
async function fmtAmount(raw, tokenAddr) {
  const m = await tokenMeta(tokenAddr);
  return `${ethers.formatUnits(raw, m.decimals)} ${esc(m.symbol)}`;
}
function tokenLabel(tokenAddr, meta) {
  if (!tokenAddr || tokenAddr.toLowerCase() === ZERO) return "BNB";
  const short = tokenAddr.slice(0, 6) + "…" + tokenAddr.slice(-4);
  return `${esc(meta.symbol)} <span class="mono">(${short})</span>`;
}

/* Scan events backwards in chunks; returns logs in ascending order. */
async function scanLogs(eventName, filterArgs, wanted) {
  return readCall(async (p) => {
    const c = readContract(p);
    const filter = filterArgs ? c.filters[eventName](...filterArgs) : c.filters[eventName]();
    const latest = await p.getBlockNumber();
    const floor = Math.max(Number(CONFIG.EVENT_FROM_BLOCK || 0), 0);
    const found = [];
    let to = latest, chunks = 0;
    while (to >= floor && chunks < CONFIG.LOG_MAX_CHUNKS && found.length < wanted) {
      const from = Math.max(floor, to - CONFIG.LOG_CHUNK + 1);
      const logs = await c.queryFilter(filter, from, to);
      found.unshift(...logs);
      to = from - 1;
      chunks++;
    }
    return found;
  });
}

const _blockTs = new Map();
async function blockTime(bn) {
  if (_blockTs.has(bn)) return _blockTs.get(bn);
  let ts = 0;
  try {
    const b = await readCall((p) => p.getBlock(bn));
    ts = b ? Number(b.timestamp) : 0;
  } catch (e) { /* leave 0 */ }
  _blockTs.set(bn, ts);
  return ts;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */
const ERROR_TEXT = {
  NotAgentHolder: "Your wallet does not hold an Agent ID.",
  NoHandle: "Your wallet has no Agent ID handle.",
  AlreadyRegistered: "This wallet is already registered on AgentPay.",
  NotRegistered: "Register your profile first.",
  ZeroAmount: "Enter an amount above zero.",
  BadExpiry: "The expiry must be in the future.",
  RequestNotFound: "This payment request does not exist.",
  RequestAlreadyPaid: "This request has already been paid.",
  RequestExpired: "This request has expired.",
  WrongValue: "The payment amount does not match the request.",
  TipTargetNotRegistered: "That agent is not registered on AgentPay.",
  ForwardFailed: "The payment could not be delivered to the payee."
};
function friendlyError(e) {
  if (!e) return "Something went wrong.";
  if (e.code === 4001 || e.code === "ACTION_REJECTED") return "Transaction rejected in your wallet.";
  const data = e.data || (e.error && e.error.data) || (e.info && e.info.error && e.info.error.data);
  if (data && typeof data === "string" && data.startsWith("0x")) {
    try {
      const parsed = new ethers.Interface(CONTRACT_ABI).parseError(data);
      if (parsed) return ERROR_TEXT[parsed.name] || ("Contract error: " + parsed.name);
    } catch (err) { /* fall through */ }
  }
  if (e.shortMessage) return e.shortMessage;
  if (e.message) return String(e.message).slice(0, 220);
  return "Transaction failed.";
}

/* ------------------------------------------------------------------ */
/* Wallet                                                              */
/* ------------------------------------------------------------------ */
const wallet = {
  provider: null, signer: null, address: null,
  handle: "", hasId: false, contract: null, registry: null, profile: null
};

async function ensureChain(provider) {
  const net = await provider.getNetwork();
  if (Number(net.chainId) === CONFIG.CHAIN_ID) return;
  try {
    await provider.send("wallet_switchEthereumChain", [{ chainId: "0x" + CONFIG.CHAIN_ID.toString(16) }]);
  } catch (e) {
    if (e.code === 4902) {
      await provider.send("wallet_addEthereumChain", [{
        chainId: "0x" + CONFIG.CHAIN_ID.toString(16),
        chainName: CONFIG.CHAIN_NAME,
        nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
        rpcUrls: CONFIG.RPCS,
        blockExplorerUrls: [CONFIG.EXPLORER]
      }]);
    } else { throw e; }
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    toast("No wallet found. Open this page in a browser with Binance Wallet or MetaMask installed.", true);
    return;
  }
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    await ensureChain(provider);
    const signer = await provider.getSigner();
    wallet.provider = provider;
    wallet.signer = signer;
    wallet.address = await signer.getAddress();
    wallet.contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONTRACT_ABI, signer);
    wallet.registry = new ethers.Contract(CONFIG.REGISTRY_ADDRESS, REGISTRY_ABI, provider);
    await refreshIdentity();
    $("#connectBtn").textContent = "Connected";
    router();
    toast(wallet.hasId ? `Connected as ${wallet.handle}.ai` : "Connected — but this wallet holds no Agent ID.");
  } catch (e) {
    toast(friendlyError(e), true);
  }
}

async function refreshIdentity() {
  if (!wallet.address) return;
  try {
    const bal = await wallet.registry.balanceOf(wallet.address);
    wallet.hasId = bal > 0n;
    wallet.handle = wallet.hasId ? await wallet.registry.handleOf(wallet.address) : "";
  } catch (e) { wallet.hasId = false; wallet.handle = ""; }
  const who = $("#who");
  if (wallet.hasId) {
    $("#whoHandle").textContent = wallet.handle + ".ai";
    who.classList.add("on");
  } else {
    who.classList.remove("on");
  }
  renderBanner();
  renderProfile();
  refreshWriteButtons();
}

function refreshWriteButtons() {
  const ok = CONFIGURED && !!wallet.signer && wallet.hasId;
  $$("[data-write]").forEach((b) => { b.disabled = !ok; });
}

function renderBanner() {
  const b = $("#banner");
  if (!CONFIGURED) {
    b.innerHTML = `<div class="notice gold"><strong>Preview mode.</strong>
      This site is not connected to a deployed contract yet (config.js still holds a placeholder address),
      so on-chain data and actions are disabled. The interface below is fully browsable.</div>`;
    return;
  }
  if (wallet.signer && !wallet.hasId) {
    b.innerHTML = `<div class="notice gold"><strong>An Agent ID is needed.</strong>
      The connected wallet does not hold an Agent ID, so paying, tipping and creating requests are disabled.
      Agent IDs are claimed free inside the Binance App (Wallet &rarr; Agent ID banner) — one per wallet.</div>`;
    return;
  }
  b.innerHTML = "";
}

/* Parse one of our events out of a tx receipt. */
function eventFromReceipt(rc, name) {
  if (!rc) return null;
  const iface = wallet.contract.interface;
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== CONFIG.CONTRACT_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch (e) { /* not ours */ }
  }
  return null;
}

/* Send a write tx with consistent UX. Returns the receipt or null. */
async function sendTx(fn, okMsg) {
  if (!CONFIGURED) { toast("Preview mode — no contract connected.", true); return null; }
  if (!wallet.signer) { toast("Connect your wallet first.", true); return null; }
  if (!wallet.hasId) { toast("You need an Agent ID to do this.", true); return null; }
  try {
    const tx = await fn(wallet.contract);
    toast("Transaction sent — waiting for confirmation…");
    const rc = await tx.wait();
    if (okMsg) toast(okMsg);
    return rc;
  } catch (e) {
    toast(friendlyError(e), true);
    return null;
  }
}

async function ensureAllowance(tokenAddr, amount) {
  const erc = new ethers.Contract(tokenAddr, ERC20_ABI, wallet.signer);
  const cur = await erc.allowance(wallet.address, CONFIG.CONTRACT_ADDRESS);
  if (cur >= amount) return;
  toast("One approval is needed so the payment can go directly to the payee — confirm it in your wallet.");
  const tx = await erc.approve(CONFIG.CONTRACT_ADDRESS, amount);
  await tx.wait();
}

/* ------------------------------------------------------------------ */
/* Profile (home)                                                      */
/* ------------------------------------------------------------------ */
async function renderProfile() {
  const body = $("#profileBody");
  if (!body) return;
  if (!wallet.signer) {
    body.innerHTML = `<p class="loading">Connect your wallet to see your profile.</p>`;
    return;
  }
  if (!wallet.hasId) {
    body.innerHTML = `<p class="empty">This wallet holds no Agent ID, so it cannot register, pay or tip on AgentPay.
      Claim a free Agent ID in the Binance App first.</p>`;
    return;
  }
  if (!CONFIGURED) {
    body.innerHTML = `<p class="empty">You are <span class="handle">${dispHandle(wallet.handle)}</span> — registration opens once the contract is deployed.</p>`;
    return;
  }
  try {
    const p = await readCall((pr) => readContract(pr).profileByAddress(wallet.address));
    wallet.profile = p;
    if (!p.registered) {
      body.innerHTML = `
        <p>You are <span class="handle">${dispHandle(wallet.handle)}</span>, but you have not registered yet.
        Registering is a single on-chain transaction and makes your pay page live.</p>
        <p style="margin-top:12px"><button class="primary" id="registerBtn" data-write>Register ${dispHandle(wallet.handle)}</button></p>`;
      $("#registerBtn").addEventListener("click", async () => {
        const rc = await sendTx((c) => c.registerProfile(), "Profile registered — your pay page is live.");
        if (rc) { await refreshIdentity(); }
      });
      refreshWriteButtons();
      return;
    }
    const sent = await readCall((pr) => readContract(pr).sentCount(wallet.address));
    const payUrl = location.href.split("#")[0] + "#/pay/" + encodeURIComponent(p.handle);
    body.innerHTML = `
      <p style="font-size:17px;margin:0">You are <span class="handle">${dispHandle(p.handle)}</span>
      <span class="badge done">registered</span></p>
      <div class="stat-row">
        <div class="stat"><div class="num">${p.receivedCount}</div><div class="lbl">payments received</div></div>
        <div class="stat"><div class="num">${ethers.formatEther(p.receivedVolumeBNB)} BNB</div><div class="lbl">volume received</div></div>
        <div class="stat"><div class="num">${sent}</div><div class="lbl">payments sent</div></div>
      </div>
      <label class="f">Your shareable pay page</label>
      <div class="sharebox">
        <input type="text" readonly value="${esc(payUrl)}" id="payUrlInput">
        <button class="small" id="copyPayUrl">Copy</button>
      </div>`;
    $("#copyPayUrl").addEventListener("click", () => {
      $("#payUrlInput").select();
      navigator.clipboard && navigator.clipboard.writeText(payUrl);
      toast("Pay page link copied.");
    });
  } catch (e) {
    body.innerHTML = `<p class="empty">Could not load your profile right now.</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Create request                                                      */
/* ------------------------------------------------------------------ */
async function createRequest() {
  const type = $("#reqTokenType").value;
  let token = ZERO, decimals = 18;
  if (type === "erc20") {
    token = $("#reqTokenAddr").value.trim();
    if (!ethers.isAddress(token)) { toast("Enter a valid token contract address.", true); return; }
    decimals = (await tokenMeta(token)).decimals;
  }
  const amountStr = $("#reqAmount").value.trim();
  let amount;
  try { amount = ethers.parseUnits(amountStr, decimals); }
  catch (e) { toast("Enter a valid amount.", true); return; }
  if (amount <= 0n) { toast("Enter an amount above zero.", true); return; }
  const memo = $("#reqMemo").value.trim();
  const expVal = $("#reqExpiry").value;
  const expiry = expVal ? Math.floor(new Date(expVal).getTime() / 1000) : 0;
  if (expiry && expiry <= Math.floor(Date.now() / 1000)) { toast("The expiry must be in the future.", true); return; }
  const reusable = $("#reqReusable").checked;

  const rc = await sendTx((c) => c.createRequest(token, amount, memo, expiry, reusable), "Payment request created.");
  if (!rc) return;
  const ev = eventFromReceipt(rc, "RequestCreated");
  if (ev) {
    const url = location.href.split("#")[0] + "#/req/" + ev.args.id.toString();
    $("#createResult").innerHTML = `
      <div class="notice teal" style="margin-top:14px"><strong>Request #${ev.args.id} is live.</strong>
      Share this link with the payer:
      <div class="sharebox"><input type="text" readonly value="${esc(url)}">
      <button class="small" id="copyReqUrl">Copy</button></div></div>`;
    $("#copyReqUrl").addEventListener("click", () => {
      navigator.clipboard && navigator.clipboard.writeText(url);
      toast("Request link copied.");
    });
  }
}

/* ------------------------------------------------------------------ */
/* Tips                                                                */
/* ------------------------------------------------------------------ */
function cleanHandleInput(v) {
  v = (v || "").trim().toLowerCase();
  if (v.endsWith(".ai")) v = v.slice(0, -3);
  return v;
}
async function sendTip(handleRaw, amountStr, memo) {
  const handle = cleanHandleInput(handleRaw);
  if (!/^[a-z0-9]{3,20}$/.test(handle)) { toast("Enter a valid agent handle (3–20 letters or digits).", true); return false; }
  let value;
  try { value = ethers.parseEther(amountStr.trim()); }
  catch (e) { toast("Enter a valid BNB amount.", true); return false; }
  if (value <= 0n) { toast("Enter an amount above zero.", true); return false; }
  const rc = await sendTx((c) => c.tip(handle, memo || "", { value }), `Tip sent to ${handle}.ai`);
  return !!rc;
}

/* ------------------------------------------------------------------ */
/* Live payments feed                                                  */
/* ------------------------------------------------------------------ */
async function loadFeed() {
  const feed = $("#feed");
  if (!CONFIGURED) { feed.innerHTML = `<p class="empty">The feed goes live once the contract is deployed.</p>`; return; }
  try {
    const logs = await scanLogs("PaymentRecorded", null, 25);
    if (!logs.length) { feed.innerHTML = `<p class="empty">No payments recorded yet — be the first.</p>`; return; }
    const items = logs.slice(-25).reverse();
    const html = [];
    for (const log of items) {
      const a = log.args;
      const ts = await blockTime(log.blockNumber);
      const amt = await fmtAmount(a.amount, a.token);
      html.push(`
        <div class="item">
          <div class="head">
            <span><span class="handle">${dispHandle(a.payerHandle)}</span> &rarr;
                  <span class="handle">${dispHandle(a.payeeHandle)}</span>
                  ${a.requestId > 0n ? `<span class="badge">request #${a.requestId}</span>` : `<span class="badge warn">tip</span>`}</span>
            <span class="amt">${amt}</span>
          </div>
          ${a.memo ? `<div class="memo">${esc(a.memo)}</div>` : ""}
          <div class="meta">${ts ? fmtDate(ts) + " · " : ""}${txLink(log.transactionHash)}</div>
        </div>`);
    }
    feed.innerHTML = html.join("");
  } catch (e) {
    feed.innerHTML = `<p class="empty">Could not load the payments feed right now.</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Pay page (#/pay/<handle>)                                           */
/* ------------------------------------------------------------------ */
async function renderPayPage(handle) {
  const prof = $("#payProfile");
  const reqs = $("#payRequests");
  prof.innerHTML = `<p class="loading">Loading profile…</p>`;
  reqs.innerHTML = `<p class="loading">Loading…</p>`;
  if (!CONFIGURED) {
    prof.innerHTML = `<p class="empty">Preview mode — profiles go live once the contract is deployed.</p>`;
    reqs.innerHTML = "";
    return;
  }
  let p;
  try {
    p = await readCall((pr) => readContract(pr).profileOf(handle));
  } catch (e) {
    prof.innerHTML = `<p class="empty">Could not load this profile right now.</p>`;
    reqs.innerHTML = "";
    return;
  }
  if (!p.registered) {
    prof.innerHTML = `<h2><span class="handle">${dispHandle(handle)}</span></h2>
      <p class="empty">This agent has not registered on AgentPay yet, so it cannot receive payments or tips here yet.</p>`;
    reqs.innerHTML = `<p class="empty">No requests.</p>`;
    return;
  }
  prof.innerHTML = `
    <h2>Pay <span class="handle">${dispHandle(p.handle)}</span></h2>
    <p class="sub">Registered since ${fmtDate(p.joinedAt)}. Payments go straight to this agent — AgentPay never holds funds.</p>
    <div class="stat-row">
      <div class="stat"><div class="num">${p.receivedCount}</div><div class="lbl">payments received</div></div>
      <div class="stat"><div class="num">${ethers.formatEther(p.receivedVolumeBNB)} BNB</div><div class="lbl">volume received</div></div>
    </div>
    <div class="formrow" style="margin-top:14px">
      <div><label class="f" for="payTipAmount">Tip amount (BNB)</label>
      <input type="text" id="payTipAmount" placeholder="0.01" inputmode="decimal"></div>
      <div><label class="f" for="payTipMemo">Memo (optional)</label>
      <input type="text" id="payTipMemo" placeholder="Thanks!"></div>
    </div>
    <p style="margin-top:12px"><button class="primary" id="payTipBtn" data-write>Tip ${dispHandle(p.handle)}</button></p>`;
  $("#payTipBtn").addEventListener("click", async () => {
    const ok = await sendTip(p.handle, $("#payTipAmount").value, $("#payTipMemo").value);
    if (ok) { renderPayPage(handle); loadFeed(); }
  });
  refreshWriteButtons();

  /* This agent's open requests, from RequestCreated events. */
  try {
    const logs = await scanLogs("RequestCreated", null, 300);
    const mine = logs.filter((l) => l.args.creatorHandle === handle);
    if (!mine.length) { reqs.innerHTML = `<p class="empty">No requests created yet.</p>`; return; }
    const now = Math.floor(Date.now() / 1000);
    const cards = [];
    for (const log of mine.slice().reverse()) {
      const id = log.args.id;
      const r = await readCall((pr) => readContract(pr).requestOf(id));
      const expired = Number(r.expiry) !== 0 && now > Number(r.expiry);
      if (r.paid || expired) continue;
      const amt = await fmtAmount(r.amount, r.token);
      cards.push(`
        <div class="item">
          <div class="head"><span>Request <strong>#${id}</strong>
            ${r.reusable ? `<span class="badge open">reusable</span>` : `<span class="badge">one-time</span>`}</span>
            <span class="amt">${amt}</span></div>
          ${r.memo ? `<div class="memo">${esc(r.memo)}</div>` : ""}
          <div class="meta">${r.paymentCount} payment(s) so far${Number(r.expiry) ? " · expires " + fmtDate(r.expiry) : " · never expires"}</div>
          <div class="actions"><a class="btn small primary" href="#/req/${id}">Open &amp; pay</a></div>
        </div>`);
    }
    reqs.innerHTML = cards.length ? cards.join("") : `<p class="empty">No open requests right now.</p>`;
  } catch (e) {
    reqs.innerHTML = `<p class="empty">Could not load requests right now.</p>`;
  }
}

/* ------------------------------------------------------------------ */
/* Request page (#/req/<id>)                                           */
/* ------------------------------------------------------------------ */
async function renderReqPage(idStr) {
  const box = $("#reqDetail");
  box.innerHTML = `<p class="loading">Loading request…</p>`;
  if (!CONFIGURED) { box.innerHTML = `<p class="empty">Preview mode — requests go live once the contract is deployed.</p>`; return; }
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 1) { box.innerHTML = `<p class="empty">Invalid request link.</p>`; return; }
  let r;
  try {
    r = await readCall((pr) => readContract(pr).requestOf(id));
  } catch (e) {
    box.innerHTML = `<p class="empty">Could not load this request right now.</p>`;
    return;
  }
  if (!r.creator || r.creator.toLowerCase() === ZERO) {
    box.innerHTML = `<p class="empty">This payment request does not exist.</p>`;
    return;
  }
  const meta = await tokenMeta(r.token);
  const amt = await fmtAmount(r.amount, r.token);
  const now = Math.floor(Date.now() / 1000);
  const expired = Number(r.expiry) !== 0 && now > Number(r.expiry);
  const status = r.paid
    ? `<span class="badge done">paid</span>`
    : expired
      ? `<span class="badge dead">expired</span>`
      : `<span class="badge open">open</span>`;
  box.innerHTML = `
    <h2>Payment request #${id} ${status}</h2>
    <p class="sub">Pay <span class="handle">${dispHandle(r.creatorHandle)}</span> — funds go directly to this agent.</p>
    <div class="kv"><span class="k">Amount</span><span class="v">${amt}</span></div>
    <div class="kv"><span class="k">Currency</span><span class="v">${tokenLabel(r.token, meta)}</span></div>
    ${r.memo ? `<div class="kv"><span class="k">Memo</span><span class="v">${esc(r.memo)}</span></div>` : ""}
    <div class="kv"><span class="k">Type</span><span class="v">${r.reusable ? "Reusable (open tab)" : "One-time"}</span></div>
    <div class="kv"><span class="k">Expires</span><span class="v">${Number(r.expiry) ? fmtDate(r.expiry) : "Never"}</span></div>
    <div class="kv"><span class="k">Payments so far</span><span class="v">${r.paymentCount}</span></div>
    ${(!r.paid && !expired) ? `<p style="margin-top:16px"><button class="primary" id="payReqBtn" data-write>Pay ${amt}</button></p>
    <p class="meta" style="color:var(--muted);font-size:12.5px">You confirm the payment in your own wallet. An Agent ID is required to pay.</p>` : ""}`;
  const btn = $("#payReqBtn");
  if (btn) {
    btn.addEventListener("click", async () => {
      if (!wallet.signer) { toast("Connect your wallet first.", true); return; }
      if (!wallet.hasId) { toast("You need an Agent ID to pay.", true); return; }
      try {
        if (r.token.toLowerCase() === ZERO) {
          const rc = await sendTx((c) => c.payRequest(id, { value: r.amount }), "Request paid.");
          if (rc) renderReqPage(idStr);
        } else {
          await ensureAllowance(r.token, r.amount);
          const rc = await sendTx((c) => c.payRequest(id), "Request paid.");
          if (rc) renderReqPage(idStr);
        }
      } catch (e) { toast(friendlyError(e), true); }
    });
  }
  refreshWriteButtons();
}

/* ------------------------------------------------------------------ */
/* Router + init                                                       */
/* ------------------------------------------------------------------ */
function router() {
  const hash = location.hash || "#/";
  const pay = hash.match(/^#\/pay\/([a-z0-9]{3,20})$/i);
  const req = hash.match(/^#\/req\/(\d+)$/);
  $("#view-home").classList.toggle("hidden", !!(pay || req));
  $("#view-pay").classList.toggle("hidden", !pay);
  $("#view-req").classList.toggle("hidden", !req);
  if (pay) renderPayPage(pay[1].toLowerCase());
  else if (req) renderReqPage(req[1]);
  else { renderProfile(); }
}

function init() {
  renderBanner();
  refreshWriteButtons();
  $("#connectBtn").addEventListener("click", connectWallet);
  $("#createReqBtn").addEventListener("click", createRequest);
  $("#tipBtn").addEventListener("click", async () => {
    const ok = await sendTip($("#tipHandle").value, $("#tipAmount").value, $("#tipMemo").value);
    if (ok) loadFeed();
  });
  $("#reqTokenType").addEventListener("change", (e) => {
    $("#reqTokenAddr").classList.toggle("hidden", e.target.value !== "erc20");
  });
  window.addEventListener("hashchange", router);
  if (window.ethereum) {
    window.ethereum.on && window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on && window.ethereum.on("chainChanged", () => location.reload());
  }
  router();
  loadFeed();
}
document.addEventListener("DOMContentLoaded", init);
