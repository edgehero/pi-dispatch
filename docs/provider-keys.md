# Provider API keys

Open **Configuration → Connections → Provider API keys** to manage keys between first-run sessions. The
setup page links to the same controls, including after all eight setup steps are ready.

Each row names a provider and its canonical environment slot, with configured, missing, managed, shadowed
or unknown source facts. A configured key has not been validated by this page. The inventory includes the
deployment default, providers in validated trigger/model/fallback/role routes, explicit managed bindings and
known slots that are configured but currently unused. Providers sharing one slot appear together.

Choose another reviewed provider in the **Provider** selector. Saving its credential does not change the default
provider, model, roles, routing, budgets or egress. Custom providers, cloud credential chains and special
subscription logins retain their supported host setup instead of a generic token field.

## Find or create a key at the provider

These links open the provider's own account pages. Sign-in may be required. pi-dispatch does not create keys
through a provider API and never retrieves a saved secret. Some providers display a new secret only once;
if it is lost, create a replacement at the provider.

- **Anthropic / Claude API:** open [Claude Console API keys](https://platform.claude.com/settings/keys),
  select the intended workspace/account and create a key. Follow the [official key guide](https://platform.claude.com/docs/en/get-api-key).
- **OpenAI API:** open [OpenAI Platform API keys](https://platform.openai.com/api-keys), select the intended
  project and create a key. The [official quickstart](https://developers.openai.com/api/docs/quickstart)
  describes API-key authentication. A ChatGPT subscription is a separate route, described below.
- **Google Gemini API:** open [Google AI Studio API keys](https://aistudio.google.com/apikey), choose the
  project and create a Gemini API key using the [current official instructions](https://ai.google.dev/gemini-api/docs/api-key).
  Vertex authentication is a different host credential flow.
- **OpenRouter:** open [workspace keys](https://openrouter.ai/workspaces/default/keys), create a named key
  and choose its credit limit. See [official API authentication](https://openrouter.ai/docs/api_reference/authentication).
- **DeepSeek:** open [DeepSeek API keys](https://platform.deepseek.com/api_keys) and create a key for the
  deployment. The [official first-call guide](https://api-docs.deepseek.com/) links to its key page.

Links were reviewed on 2026-11-01. The five direct key pages are official destinations; authenticated content
is not proof a particular account can create a key. Other provider choices link to this setup guide rather
than an invented dashboard URL. Consult that provider's own documentation for its account and key workflow.

## Add and replace

**Add** only fills an absent or decoded-empty canonical slot. A nonempty whitespace assignment requires Replace
too. **Replace** is a separate destructive confirmation for an existing key. Its preview names the provider,
exact slot and every shared-slot alias. A replacement affects
all consumers of that slot; it does not change a managed subscription binding or another provider's distinct slot.
The old secret is not shown or retained for Undo. If the slot, file, provider source or sign-in changes after
preview, confirm refuses and requires a fresh preview.

The field is write-only, at most 4 KiB. Preview clears it. Cancel, expiry, provider selection changes and
session end discard the pending input; enter it again after a refusal. No saved key, prefix or fingerprint
appears in the list, help, audit, logs or live panels. At most one private key preview per sign-in is pending
across Add and Replace, for no more than 60 seconds.

A managed binding continues to own its provider even when disconnected. An inherited environment credential
or higher-priority bearer/OAuth source may also make an environment-file key ineffective. Those cases show
host recovery instead of silently replacing a different source. Where a host pi API-key login is the fallback,
the preview explicitly explains that a deployment key will take precedence; it never edits `auth.json`.

Saving a key does not reload a running worker or validate the key through paid inference. Restarting uses a
separate preview and confirmation, can interrupt in-flight or newly admitted work and cannot undo spending.
Already running jobs keep credentials they received. This host operation does not propagate a key to other
workers. After every affected consumer has reloaded and the new credential is verified, revoke the old key at
the provider. pi-dispatch does not revoke upstream keys for you.

## Subscription and special authentication

For supported host-owned OpenAI ChatGPT and reviewed Claude community connections, use
[Subscription authentication](subscription-auth.md). A browser API-key form is not an OAuth-token input.
OpenAI API keys and Sign in with ChatGPT are separate authentication and billing choices.

Copilot's runtime credential variable does not mean a general GitHub personal access token is suitable.
Amazon Bedrock, Google Vertex, legacy `openai-codex` and custom provider routes retain their own supported
host setup. A canonical variable name is not proof a provider offers manual dashboard key creation.
