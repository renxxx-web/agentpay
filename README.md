# AgentPay — pay agents by name

Project A of our Binance Agent ID Hackathon entry (entered by **renx.ai**).

Pay any registered agent by its **.ai name** — invoices ("payment requests"),
tips and on-chain receipts for the agent economy. AgentPay is fully
**non-custodial**: the `AgentPay` contract never holds funds; every payment is
forwarded from payer to payee inside the same transaction, and if the forward
fails the whole transaction reverts.

Identity comes from the Agent ID registry
(`0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` on BNB Smart Chain):

- Only Agent ID holders can pay, tip or create requests.
- Payees opt in by registering the handle they hold (`registerProfile`).
- Recipients are addressed by handle (e.g. `renx.ai`), never by raw wallet
  address — the site never displays a resolved 0x address for a handle.

## Pages / flows

- **Home** — your profile (register, stats, shareable pay page), tip form,
  create-a-request form, and a live feed of `PaymentRecorded` events.
- **`#/pay/<handle>`** — an agent's public pay page: profile stats, tip form,
  and their open payment requests.
- **`#/req/<id>`** — a single payment request with a Pay button (BNB paid
  directly; ERC-20 paid after a one-time token approval, straight to the
  creator).

## Running it

It is a plain static site — no build step, no server code. Serve the folder
with any static host, e.g.:

```sh
python3 -m http.server 8000
# or: npx serve .
```

…or publish the folder as-is to GitHub Pages. Open `index.html` via the server
(not `file://`, so the CDN scripts load correctly) and connect a wallet
(Binance Wallet or MetaMask) on BNB Smart Chain.

## Configuration (after deployment)

Edit `config.js`:

| Key | What to set |
|---|---|
| `CONTRACT_ADDRESS` | The deployed `AgentPay` contract address. Until set, the site runs in preview mode (UI browsable, chain actions disabled). |
| `EVENT_FROM_BLOCK` | The block the contract was deployed in; event feeds scan from here. |
| `REGISTRY_ADDRESS` | Already set to the real Agent ID registry — do not change. |
| `RPCS` | Public BSC read endpoints (primary + fallback). |

`abi.js` is generated from the compiled contract artifact
(`contracts/out/AgentPay.sol/AgentPay.json`) plus minimal registry / ERC-20
ABIs. Regenerate it if the contract changes.

## Notes

- Users confirm every transaction in their own wallet; there is no QR login
  and no server-side session.
- Wallets without an Agent ID can browse, but write actions are disabled with
  an explanatory notice (Agent IDs are claimed free in the Binance App).
