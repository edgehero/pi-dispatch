import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { Event, runConsoleScript, parseDocument } from "./helpers/script-dom.mjs";

const markup = `<html><body><span class="who" data-name="reader" data-role="viewer"></span><form data-trigger-check><fieldset data-trigger-check-fields disabled><select name="forge"><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="azure">Azure</option></select><select name="event"><option value="issue-labeled">Label</option><option value="issue-comment">Comment</option><option value="pull-request">PR</option><option value="issue-closed" data-check-forge="github">Closed</option></select><input name="repository" value="org/repo"><input name="number" value="7"><select name="actor"><option value="write">Write (assumed)</option><option value="read">Read</option></select>${["action", "prAuthor", "reviewState", "reviewBody"].map((n) => `<label data-check-field="${n}"><select name="${n}"><option value="${({action:"opened",prAuthor:"write",reviewState:"approved",reviewBody:"present"})[n]}">Value</option><option value="review_submitted">Review</option></select></label>`).join("")}${["labels", "previousLabels", "comment"].map((n) => `<label data-check-field="${n}"><textarea name="${n}"></textarea></label>`).join("")}<button type="submit">Check</button></fieldset><section data-trigger-check-result tabindex="-1" aria-live="polite">Describe an event.</section></form></body></html>`;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function world() {
  const w = runConsoleScript(CONSOLE_SCRIPT, markup, { url: "/triggers/check" });
  w.form = w.document.querySelector("form[data-trigger-check]");
  w.result = w.document.querySelector("[data-trigger-check-result]");
  w.field = (n) => w.form.querySelector(`[name="${n}"]`);
  w.change = (n, value, event = "change") => { w.field(n).value = value; if (w.field(n).localName === "select") for (const option of w.field(n).querySelectorAll("option")) option.liveSelected = option.value === value; w.field(n).dispatchEvent(new Event(event, { bubbles: true })); };
  return w;
}
test("checker is disabled without script; viewer script enables it and sends private typed data by identity-bound POST only", async () => {
  assert.equal(parseDocument(markup).querySelector("fieldset").disabled, true);
  const w = world();
  assert.equal(w.form.querySelector("fieldset").disabled, false);
  w.change("labels", "go, now\n needs-review \n", "input");
  w.submit(w.form); w.submit(w.form);
  assert.equal(w.fetch.calls.length, 1, "double submit does not send a second request");
  const call = w.fetch.calls[0];
  assert.equal(call.url, "/api/trigger-check");
  assert.equal(call.method, "POST");
  assert.equal(call.init.headers["x-console-as"], "reader.viewer");
  assert.equal(call.init.credentials, "same-origin");
  assert.deepEqual(call.body, { forge:"github",event:"issue-labeled",repository:"org/repo",number:7,actor:"write",labels:["go, now", "needs-review"] });
  assert.equal(w.form.getAttribute("aria-busy"), "true");
  call.answer(200, { html: "<p>Row 1 matches hypothetically.</p>" }); await flush();
  assert.match(w.result.textContent, /Row 1 matches/);
  assert.equal(w.field("labels").value, "go, now\n needs-review \n");
  assert.equal(w.document.activeElement, w.result);
  assert.equal(w.form.hasAttribute("aria-busy"), false);
  assert.deepEqual(w.history.states, []);
});
test("forge/event/action changes submit only applicable controls and preserve hidden descriptions", () => {
  const w = world();
  w.change("comment", "private-description");
  w.change("event", "pull-request");
  assert.equal(w.field("comment").disabled, true);
  assert.equal(w.field("prAuthor").disabled, false);
  w.change("action", "review_submitted");
  assert.equal(w.field("reviewState").disabled, false);
  w.change("forge", "azure");
  assert.equal(w.field("labels").disabled, true);
  assert.equal(w.field("prAuthor").disabled, true);
  assert.equal(w.field("reviewState").disabled, true);
  w.submit(w.form);
  assert.equal(w.fetch.calls[0].body.comment, undefined);
  assert.equal(w.fetch.calls[0].body.labels, undefined);
  assert.equal(w.field("comment").value, "private-description");
});
test("editing a pending check discards its response; out-of-order answers cannot replace the current check", async () => {
  const w = world(); w.submit(w.form);
  w.change("repository", "new/repo", "input");
  assert.match(w.result.textContent, /description changed/);
  w.submit(w.form);
  w.fetch.calls[1].answer(200, { html:"<p>Newest</p>" }); await flush();
  w.fetch.calls[0].answer(200, { html:"<p>Stale private response</p>" }); await flush();
  assert.equal(w.result.textContent, "Newest");
  assert.equal(w.field("repository").value, "new/repo");
});
test("silent input mutation and a bounded timeout both invalidate pending answers without changing inputs", async () => {
  const w = world(); w.submit(w.form); w.field("repository").value = "silent/change";
  w.fetch.calls[0].answer(200,{html:"<p>Stale</p>"}); await flush();
  assert.match(w.result.textContent,/description changed/);
  w.submit(w.form); w.tick(10000);
  assert.match(w.result.textContent,/timed out/);
  assert.equal(w.form.querySelector('[type="submit"]').disabled,false);
  w.fetch.calls[1].answer(200,{html:"<p>Late</p>"}); await flush();
  assert.match(w.result.textContent,/timed out/);
  assert.equal(w.field("repository").value,"silent/change");
});
test("only server-rendered check answers enter the fixed sink; hostile transport/session errors never become markup or text", async () => {
  for (const status of [401,409,429,503]) {
    const w=world(); w.submit(w.form);
    w.fetch.calls[0].answer(status,{html:'<img src=x onerror="private-canary">',error:'<script>private-canary</script>'}); await flush();
    assert.doesNotMatch(w.result.innerHTML,/private-canary|<img|<script/);
    assert.equal(w.field("repository").value,"org/repo");
    assert.match(w.result.textContent,status===401||status===409?/session changed or ended/:/unavailable/);
  }
  const bad=world();bad.submit(bad.form);bad.fetch.calls[0].answer(200,{html:42});await flush();assert.match(bad.result.textContent,/unavailable/);
  const refused=world();refused.submit(refused.form);refused.fetch.calls[0].answer(400,{html:"<p>Invalid description.</p>"});await flush();assert.equal(refused.result.textContent,"Invalid description.");
  const offline=world();offline.submit(offline.form);offline.fetch.calls[0].fail();await flush();assert.match(offline.result.textContent,/could not connect/);
});
test("the check markup sink is bound once to its fixed region and cannot replace the form", () => {
  assert.match(CONSOLE_SCRIPT,/var checkResult = document\.querySelector\("\[data-trigger-check-result\]"\);/);
  assert.deepEqual(CONSOLE_SCRIPT.match(/\bcheckResult\s*=(?!=)/g),["checkResult ="]);
  assert.deepEqual(CONSOLE_SCRIPT.match(/checkResult\.innerHTML\s*=/g),["checkResult.innerHTML ="]);
  assert.doesNotMatch(CONSOLE_SCRIPT,/checkForm\.innerHTML\s*=/);
});
