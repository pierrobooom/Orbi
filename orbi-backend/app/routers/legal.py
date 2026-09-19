"""Privacy policy and terms, served as public pages.

WHY THESE ARE SERVED BY THE API
Enable Banking's Production applications require a privacy URL, a terms URL
and a data-protection contact, because those are shown to real people during
bank consent. The App Store requires the same before review. Orbi has no
marketing site yet, and the fastest honest answer is to serve them from the
API that already has a public hostname.

Move them to a real domain before launch — the URLs registered with Enable
Banking and with Apple must be stable, and a tunnel hostname is not.

WHAT MAKES A PRIVACY POLICY TRUE
It has to match the code. Every processor named below is one the backend
actually calls: Supabase (app/db/client.py), OpenAI (services/embeddings.py),
Groq and Anthropic (services/ai_router.py), Deepgram (services/transcription.py),
Expo (services/push.py) and the configured bank provider
(services/bank_providers.py). If a processor is added, this list changes in
the same commit — a policy that lags the code is worse than none, because it
is a specific false statement rather than a vague one.

NOT LEGAL ADVICE. This is an accurate description of what the software does,
written to be read by a person. Have it reviewed before taking money.
"""

import os
from datetime import date

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(prefix="/legal", tags=["legal"])

# Shown as the data-protection contact. Configurable so it is not baked into
# a public page by a deploy.
_CONTACT = os.environ.get("PRIVACY_CONTACT_EMAIL", "support@orbi.app")

_LAST_UPDATED = "19 September 2026"


def _page(title: str, body: str) -> str:
    """Wrap content in a readable, responsive shell. No tracking, no fonts."""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orbi — {title}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ margin:0; padding:2rem 1.25rem 5rem;
    font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    color:#1a1a1f; background:#fff; }}
  main {{ max-width:42rem; margin:0 auto; }}
  h1 {{ font-size:1.6rem; margin:0 0 .35rem; }}
  h2 {{ font-size:1.1rem; margin:2.2rem 0 .6rem; }}
  .updated {{ color:#6b6b76; font-size:.85rem; margin:0 0 2rem; }}
  ul {{ padding-left:1.2rem; }} li {{ margin:.35rem 0; }}
  code {{ background:rgba(127,127,127,.15); padding:.1rem .35rem; border-radius:4px;
    font-size:.9em; }}
  a {{ color:#5b5bd6; }}
  @media (prefers-color-scheme: dark) {{
    body {{ color:#e8e8ee; background:#0e0e14; }}
    .updated {{ color:#9b9ba5; }}
    a {{ color:#9a9aff; }}
  }}
</style></head>
<body><main>{body}
<p class="updated" style="margin-top:3rem">Orbi · Last updated {_LAST_UPDATED}</p>
</main></body></html>"""


@router.get("/privacy", response_class=HTMLResponse)
async def privacy_policy():
    """Public privacy policy. No auth — it has to be readable before signup."""
    return HTMLResponse(_page("Privacy Policy", f"""
<h1>Privacy Policy</h1>
<p class="updated">Last updated {_LAST_UPDATED}</p>

<p>Orbi is a personal task and finance assistant. This policy explains, in
plain terms, what data Orbi holds, who it is shared with, and what control you
have over it.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Account details</strong> — your name and email address, so you
      can sign in.</li>
  <li><strong>What you put in</strong> — tasks, clusters, notes, due dates,
      and the finance entries, accounts and budgets you create.</li>
  <li><strong>Voice and chat</strong> — what you say to Orbi and what it
      replies, so the conversation makes sense next time.</li>
  <li><strong>Bank data, only if you connect an account</strong> — the
      transactions and balance of accounts you explicitly approve at your
      bank. Read-only: Orbi cannot move money.</li>
  <li><strong>Device tokens</strong> — so reminders can reach your phone.</li>
  <li><strong>Error and usage logs</strong> — to keep the service working.</li>
</ul>

<h2>What we never collect</h2>
<p>Orbi never asks for or stores your online banking credentials. When you
connect a bank account you sign in on your bank's own site; Orbi does not see
your password or your security code.</p>

<h2>Who processes your data</h2>
<p>These providers process data on Orbi's behalf, only to run the service:</p>
<ul>
  <li><strong>Supabase</strong> — database, sign-in and file storage.</li>
  <li><strong>Groq</strong> and <strong>Anthropic</strong> — the AI that reads
      what you say and turns it into tasks and replies.</li>
  <li><strong>OpenAI</strong> — generates the numeric representations that
      make search and "find the task about the car" work.</li>
  <li><strong>Deepgram</strong> — speech-to-text, when your device cannot do
      it on its own.</li>
  <li><strong>Expo</strong> — delivers push notifications.</li>
  <li><strong>A licensed open-banking provider</strong> — only if you connect
      a bank account, and only to fetch the accounts you approved.</li>
</ul>
<p>Your data is not sold, not used for advertising, and not used to train
anyone's AI models.</p>

<h2>How long we keep it</h2>
<p>Your tasks and finance records stay until you delete them or delete your
account. Conversation history is kept for 30 days on the free plan, one year
on Pro, and indefinitely on Genius. Deleting your account removes everything
immediately — profile, tasks, finances, conversations, memories and device
tokens.</p>

<h2>Bank connections</h2>
<p>A bank connection is read-only, lasts about 90 days, and then has to be
approved again at your bank. You can disconnect at any time, from inside Orbi
or from your bank. Transactions already imported stay in your records, because
they are your history. Finance data is never shared with other users.</p>

<h2>Your rights</h2>
<p>Under the GDPR you may access, correct, export, restrict or delete your
data, object to its processing, and withdraw consent. Account deletion is
available in the app under Settings. For anything else, write to
<a href="mailto:{_CONTACT}">{_CONTACT}</a>. You may also complain to your
national data protection authority — in Portugal, the
<a href="https://www.cnpd.pt">CNPD</a>.</p>

<h2>Security</h2>
<p>All traffic is encrypted in transit. Data is stored on infrastructure in
the European Union where the provider offers it; some providers may process
data elsewhere under appropriate safeguards.</p>

<h2>Children</h2>
<p>Orbi is for people aged 18 or over.</p>

<h2>Changes</h2>
<p>We will update this page when the service changes, and the date at the top
always shows the latest version.</p>
"""))


@router.get("/terms", response_class=HTMLResponse)
async def terms_of_service():
    """Public terms. No auth — required before anyone can agree to them."""
    return HTMLResponse(_page("Terms & Conditions", f"""
<h1>Terms &amp; Conditions</h1>
<p class="updated">Last updated {_LAST_UPDATED}</p>

<p>These terms cover using Orbi. By creating an account you accept them.</p>

<h2>What Orbi is</h2>
<p>Orbi is a personal organisation tool for tasks and spending. It is not a
bank, not a payment service, and it does not give financial, tax, legal or
investment advice. Anything it suggests about your money is a description of
your own data, not a recommendation.</p>

<h2>Your account</h2>
<p>You are responsible for keeping access to your account secure and for what
happens under it. One account is for one person.</p>

<h2>Acceptable use</h2>
<p>Use Orbi lawfully. Do not attempt to access other people's accounts,
overload or attack the service, or reverse-engineer it.</p>

<h2>Your data is yours</h2>
<p>What you put into Orbi belongs to you. You grant us only the permission
needed to store and process it in order to provide the service, as described
in the <a href="/legal/privacy">Privacy Policy</a>. You are responsible for
the accuracy of what you record.</p>

<h2>Bank connections</h2>
<p>If you connect a bank account, you do so by authenticating directly with
your bank and approving read-only access. Orbi reads transactions through a
licensed open-banking provider and cannot initiate payments. Imported
transactions are shown as your bank reported them; your bank's own records are
always authoritative, and you should not rely on Orbi for reconciliation or
any formal purpose.</p>

<h2>AI-generated content</h2>
<p>Orbi uses AI to interpret what you say and to categorise spending. It gets
things wrong. Review anything that matters before acting on it.</p>

<h2>Plans and payment</h2>
<p>Orbi has a free plan and paid plans. Paid plans are billed through the app
store you subscribed with, and cancellation is handled there.</p>

<h2>Availability</h2>
<p>We aim to keep Orbi available and secure, but it is provided "as is"
without a guarantee of uninterrupted or error-free operation. Features may
change, be suspended, or be discontinued. Export your data if you need a copy.</p>

<h2>Limitation of liability</h2>
<p>To the maximum extent the law allows, we are not liable for decisions made
on the basis of information in the app, nor for losses from errors,
unavailability or data loss. Nothing here limits rights you have as a consumer
that cannot be limited.</p>

<h2>Ending it</h2>
<p>You can delete your account at any time in Settings. We may suspend or
close accounts that breach these terms.</p>

<h2>Governing law</h2>
<p>These terms are governed by Portuguese law, without prejudice to your
rights as a consumer in your own country.</p>

<h2>Contact</h2>
<p><a href="mailto:{_CONTACT}">{_CONTACT}</a></p>
"""))
