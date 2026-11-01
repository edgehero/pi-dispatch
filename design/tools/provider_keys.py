"""Provider-key management uses the existing Pulse fields, rows, disclosures and private confirmation."""
from pulse import *

PROVIDER_KEYS_CSS = """
.pk-intro,.pk-note { font-size: 12px; line-height: 19px; color: var(--ink-muted); }
.pk-intro { margin-bottom: 14px; }
.pk-list { display: grid; gap: 8px; }
.pk-row { display: grid; gap: 7px; padding: 12px 14px; border-radius: var(--radius-md); background: var(--surface-2); min-width: 0; }
.pk-row__title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.pk-row__title b { font-size: 13px; overflow-wrap: anywhere; }
.pk-row__title .badge { margin-left: auto; }
.pk-key { font-size: 12px; overflow-wrap: anywhere; white-space: normal; }
.pk-editor { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
.pk-editor h3,.pk-help h3 { font-size: 13px; margin: 0 0 10px; }
.pk-form { display: grid; gap: 12px; min-width: 0; }
.pk-form fieldset { display: contents; border: 0; padding: 0; margin: 0; min-width: 0; }
.pk-form .field { min-width: 0; }
.pk-form .input,.pk-form .select { width: 100%; min-width: 0; box-sizing: border-box; }
.pk-picks { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.pk-form .btn { justify-self: start; }
.pk-help { display: grid; gap: 8px; margin-top: 16px; }
.pk-guide { padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-md); min-width: 0; }
.pk-guide summary { cursor: pointer; font-size: 13px; font-weight: 650; color: var(--ink); }
.pk-guide summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.pk-guide[open] summary { margin-bottom: 10px; }
.pk-guide ol { padding-left: 20px; display: grid; gap: 6px; font-size: 12px; line-height: 19px; color: var(--ink-muted); }
.pk-links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 10px 0; }
.pk-notice { margin-top: 8px; }
.pk-default { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; margin-bottom: 12px; font-size: 13px; }
.pk-compact { display: grid; gap: 8px; margin-top: 12px; font-size: 12px; line-height: 19px; }
.pk-compact p { color: var(--ink-muted); }
@media (max-width: 760px) { .pk-picks { grid-template-columns: minmax(0, 1fr); } .pk-row__title .badge { margin-left: 0; } .pk-links .btn { max-width: 100%; height: auto; min-height: 32px; white-space: normal; text-align: center; } }
"""

def provider_keys_card():
    rows = "".join(f'''<li class="pk-row"><div class="pk-row__title">{ic('key', 'ic ic--sm')}<b>{name}</b>{'<span class="ptag">Default</span>' if default else ''}<span class="badge tone-{tone}">{word}</span></div><span class="code pk-key">{key}</span><p class="pk-note">{note}</p></li>''' for name, default, tone, word, key, note in [
        ("Anthropic", True, "ok", "Set in deployment", "ANTHROPIC_API_KEY", "Present in .env; presence does not verify that a key works."),
        ("OpenAI", False, "ok", "Set in deployment", "OPENAI_API_KEY", "Available for jobs that select OpenAI; the default stays Anthropic."),
        ("Google Gemini", False, "idle", "Not set", "GEMINI_API_KEY", "Add a separate key without changing either existing provider."),
    ])
    form = f'''<div class="pk-editor"><h3>Add or replace a provider key</h3><form class="pk-form"><fieldset disabled><div class="pk-picks"><label class="field">Provider<select class="select"><option>Anthropic</option><option>OpenAI</option><option selected>Google Gemini</option><option>OpenRouter</option><option>DeepSeek</option></select></label><label class="field">Change<select class="select"><option selected>Add a new key</option><option>Replace an existing key</option></select></label></div><label class="field">New API key<input class="input" type="password" autocomplete="off"></label><p class="pk-note">Only the selected provider slot changes. The default provider stays the same. A running worker needs a separate restart.</p>{btn('Preview the key change', 'primary', sm=False)}</fieldset></form></div>'''
    guides = "".join(f'''<details class="pk-guide"{' open' if name == 'Google Gemini' else ''}><summary>Get an API key for {name}</summary><div class="pk-links"><a class="btn btn--sm" href="{url}" rel="noreferrer noopener" target="_blank">Get API key at {name}</a></div><ol><li>Sign in at the provider and choose the account or project that will pay for these jobs.</li><li>Create a key, copy it at the provider, then paste it here and preview the change.</li></ol><p class="pk-note pk-notice">Existing saved values are never shown here. If the provider cannot show an old key, create a replacement there.</p></details>''' for name,url in [
        ("Anthropic", "https://platform.claude.com/settings/keys"), ("OpenAI", "https://platform.openai.com/api-keys"), ("Google Gemini", "https://aistudio.google.com/apikey"), ("OpenRouter", "https://openrouter.ai/workspaces/default/keys"), ("DeepSeek", "https://platform.deepseek.com/api_keys")])
    body = f'''<p class="pk-intro">Store keys for several providers. Credentials are write-only; status describes local declarations, not a successful paid request.</p><p class="pk-default"><b>Default provider: anthropic</b><a class="link" href="#">Change it separately in Configuration</a></p><ul class="pk-list">{rows}</ul>{form}<div class="pk-help"><h3>Find or create a key at the provider</h3>{guides}</div><p class="pk-note pk-notice">Using a subscription? Review Subscription authentication below. Its host sign-in is separate from API keys.</p>'''
    return card("Provider API keys", body, id_="p-provider-keys", sub="separate credentials, unchanged default")
