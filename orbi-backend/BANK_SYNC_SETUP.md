# Bank sync setup — one-time, by you, not by your users

## Who does what

This is the thing that is easy to get backwards, so it goes first.

| | Enable Banking account | Application + private key | Bank sign-in |
|---|---|---|---|
| **You (Orbi)** | yes, once | yes, once, server-side | no |
| **Your users** | never | never | yes, every time they connect |

Orbi holds **one** Enable Banking application. Its private key is Orbi's
credential for talking to Enable Banking — it identifies the *app*, not any
person. Users are never asked to sign up for anything, and must never be sent
a private key: it would grant nothing useful to them and would be a serious
security hole in their hands.

A user's entire journey is:

```
Tap "Connect"  →  redirected to their bank  →  sign in + approve  →  back in Orbi
```

That is what an aggregator is for. You hold one licence-backed identity; each
user consents at their own bank.

---

## Part 1 — Your one-time setup

### 1. Create the application

Sign up at [enablebanking.com](https://enablebanking.com) and create an
application in the Control Panel. You will get an **Application ID** (a UUID)
and be able to download an **RSA private key** (`.pem`).

Keep the `.pem` out of the repository. Put it somewhere the server can read,
and point at it by path.

### 2. Activate in Restricted Production

Use **"Activate by linking accounts"** and link your own bank account —
Revolut, in our case.

This is the free mode: no contract, no KYB, no cost. The catch is in the name.
The API will serve data **only** from accounts you personally linked here,
and filters responses to them even if a user authorises more. That is the
right guard rail for development and useless for real users — see Part 3.

### 3. Configure the server

```bash
BANK_PROVIDER=enablebanking
ENABLE_BANKING_APP_ID=<the Application ID>
ENABLE_BANKING_PRIVATE_KEY=/absolute/path/to/key.pem   # or the PEM contents
ENABLE_BANKING_REDIRECT_URL=https://<your-api>/api/v1/finance/callback
ENABLE_BANKING_ASPSP=Revolut     # the bank's name in Enable Banking's list
ENABLE_BANKING_COUNTRY=PT
```

`ENABLE_BANKING_PRIVATE_KEY` accepts either the PEM text or a path to it. A
path is far easier to configure than a multi-line value in an env var.

Every one of these is validated at use, not at import: selecting the provider
without them produces a message naming the missing variable rather than a
stack trace on a background thread.

### 4. Check it

Restart the API and confirm the provider is live:

```bash
curl -s localhost:8000/api/v1/finance/provider -H "Authorization: Bearer <jwt>"
```

`automatic_import` should be `true`. Then tap **Connect** on an account in the
app — you should be redirected to your bank rather than getting a 501.

---

## Part 2 — What your users see

Nothing about Enable Banking. The screens are:

1. **Accounts → Connect for automatic import**
2. An explainer sheet — what Orbi will and will not be able to see, that it is
   read-only, that it expires, that it can be revoked. This is the trust
   moment and the only place the user makes a decision.
3. Their bank's own login page, in a browser. Orbi never sees the password or
   the 2FA code.
4. Back in Orbi. Transactions sync once a day from then on.

Roughly every 90 days PSD2 requires them to re-approve. The app warns seven
days ahead (`GET /finance/connections/attention`), because a feed that simply
stops looks identical to a quiet month of spending — which is the worst
failure mode a finance app has.

---

## Part 3 — Going beyond your own accounts

Restricted Production serves only the accounts you linked yourself. The moment
a second person connects their bank, you need Enable Banking's commercial
tier: a signed contract and KYB verification.

**Price this before it appears on the pricing page.** Enable Banking moved to
quote-only pricing in April 2026, and open-banking pricing is normally *per
connected account per month*. Pro is £10.99, which is £7.69 after Apple's cut.
A per-account fee of a euro or two eats a large share of that before a single
AI call. This is the same shape as the ElevenLabs decision recorded in
CLAUDE.md, where the worst case turned out to be $162–324/user/month against
$9.73 of revenue — and that was only caught by pricing it.

Options if the quote is unattractive:

- **Statement import** (already built, `POST /finance/accounts/{id}/import`).
  No licence, no aggregator, no per-user cost. The user exports a CSV from
  their bank and picks it. Less fresh, entirely free.
- **Bank sync as a Genius-only feature**, where £20.99 absorbs it.
- **Bank sync as a paid add-on**, priced to cover the per-account fee.

---

## Why not build the PSD2 client ourselves

The client code is not the hard part — the specs are public. Access is a
cryptographic identity tied to a regulatory register:

```
Banco de Portugal authorisation → EBA register → a QTSP issues your
QWAC/QSEAL certificates → banks' TLS accepts you
```

Break any link and the connection is refused at the transport layer; you never
reach an endpoint. An AISP-only licence needs no minimum capital, but does
need professional indemnity insurance (roughly €5–30k/year at seed stage) and
takes 6–12 months.

And the licence is not the product. It grants the *right* to talk to ~2,500
bank APIs, each with its own portal, sandbox, quirks and unannounced changes.
That is permanent maintenance, and it is most of what the aggregator fee
actually buys.

Revisit only if aggregator fees ever become large enough to fund a compliance
function — which would be a very good problem to have.
