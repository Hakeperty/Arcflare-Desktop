// Parsing artifacts out of replies (finished and mid-stream), versions across a
// conversation, and the documents previews run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDocument, collectArtifacts, fileName, kindOf, splitArtifacts, versionIn, RUNTIME_URL } from "../../src/lib/artifacts";

test("a reply splits into prose and an artifact", () => {
  const segs = splitArtifacts('Here you go.\n<artifact id="hello-page" type="html" title="Hello page">\n<h1>Hi</h1>\n</artifact>\nWant changes?');
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0], { type: "text", text: "Here you go.\n" });
  assert.equal(segs[1].type, "artifact");
  if (segs[1].type !== "artifact") return;
  assert.deepEqual(segs[1].artifact, { id: "hello-page", kind: "html", title: "Hello page", lang: "html", content: "<h1>Hi</h1>", closed: true });
  assert.deepEqual(segs[2], { type: "text", text: "\nWant changes?" });
});

test("a fence inside the tags is taken off, and its language kept", () => {
  const [s] = splitArtifacts('<artifact id="x" type="code" title="Script">\n```python\nprint(1)\n```\n</artifact>');
  assert.ok(s.type === "artifact");
  assert.equal(s.artifact.content, "print(1)");
  assert.equal(s.artifact.lang, "python");
  assert.equal(s.artifact.kind, "code");
});

test("mid-stream: an unclosed artifact is open, a half-written tag is hidden", () => {
  const open = splitArtifacts('Sure.\n<artifact id="a" type="react" title="Counter">\nexport default function');
  assert.equal(open.length, 2);
  assert.ok(open[1].type === "artifact" && !open[1].artifact.closed && open[1].artifact.kind === "react");
  assert.deepEqual(splitArtifacts("Sure.\n<artif"), [{ type: "text", text: "Sure.\n" }]);
  assert.deepEqual(splitArtifacts('Sure.\n<artifact id="a" ty'), [{ type: "text", text: "Sure.\n" }]);
  assert.deepEqual(splitArtifacts("a < b"), [{ type: "text", text: "a < b" }]);
});

test("types map onto kinds, with a missing id taken from the title", () => {
  assert.equal(kindOf("application/vnd.ant.react"), "react");
  assert.equal(kindOf("image/svg+xml"), "svg");
  assert.equal(kindOf("text/html"), "html");
  assert.equal(kindOf("text/markdown"), "markdown");
  assert.equal(kindOf("code", "rust"), "code");
  const [s] = splitArtifacts("<artifact title='My Great Doc' type='markdown'># Hi</artifact>");
  assert.ok(s.type === "artifact" && s.artifact.id === "my-great-doc");
});

test("the same id across replies is one artifact with versions, newest touched first", () => {
  const turns = [
    { id: "u1", role: "user", content: '<artifact id="nope" type="html">not mine</artifact>' },
    { id: "a1", role: "assistant", content: '<artifact id="page" type="html" title="Page">v1</artifact><artifact id="logo" type="svg" title="Logo"><svg/></artifact>' },
    { id: "a2", role: "assistant", content: '<artifact id="page" type="html" title="Page v2">v2</artifact>' },
  ];
  const th = collectArtifacts(turns);
  assert.deepEqual(th.map((t) => t.id), ["page", "logo"]);
  assert.deepEqual(th[0].versions.map((v) => v.content), ["v1", "v2"]);
  assert.equal(th[0].title, "Page v2");
  assert.equal(versionIn(th, "page", "a1"), 1);
  assert.equal(versionIn(th, "page", "a2"), 2);
});

test("previews: html gets the boot script, svg is wrapped, react loads the runtime", () => {
  const full = buildDocument({ kind: "html", title: "t", content: "<!doctype html><html><head><title>x</title></head><body>hi</body></html>" })!;
  assert.match(full, /<head><script>\(function\(\)\{/);
  assert.match(full, /<body>hi<\/body>/);
  const frag = buildDocument({ kind: "html", title: "t", content: "<p>hi</p>" })!;
  assert.match(frag, /^<!doctype html>.*<body><p>hi<\/p><\/body><\/html>$/s);
  assert.match(buildDocument({ kind: "svg", title: "t", content: "<svg></svg>" })!, /<body><svg><\/svg><\/body>/);
  const react = buildDocument({ kind: "react", title: "t", content: 'const s = "</script><script>alert(1)</script>";' })!;
  assert.ok(react.includes(RUNTIME_URL));
  assert.ok(!react.includes("</script><script>alert(1)"), "source can't close the script tag it sits in");
  assert.equal(buildDocument({ kind: "markdown", title: "t", content: "# x" }), null);
});

test("saved files get a sensible extension", () => {
  assert.equal(fileName({ id: "page", kind: "html", lang: "html" }), "page.html");
  assert.equal(fileName({ id: "app", kind: "react", lang: "jsx" }), "app.jsx");
  assert.equal(fileName({ id: "s", kind: "code", lang: "Python" }), "s.py");
  assert.equal(fileName({ id: "s", kind: "code", lang: "brainfuck" }), "s.txt");
});
