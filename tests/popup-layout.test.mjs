import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const popupCSS = await readFile(new URL("../src/ui/popup.css", import.meta.url), "utf8");

test("desktop popup has an intrinsic size instead of depending on Safari's provisional viewport", () => {
  assert.doesNotMatch(popupCSS, /width:\s*min\(390px,\s*100vw\)/);
  assert.match(popupCSS, /html\s*{[^}]*height:\s*600px;[^}]*overflow:\s*hidden;/s);
  assert.match(
    popupCSS,
    /body\s*{[^}]*height:\s*600px;[^}]*min-width:\s*390px;[^}]*overflow-y:\s*auto;[^}]*width:\s*390px;/s
  );
});

test("touch popups use the device sheet instead of the fixed desktop popover", () => {
  assert.match(
    popupCSS,
    /@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)\s*{[\s\S]*?html,[\s\S]*?body\s*{[^}]*height:\s*auto;[^}]*width:\s*100%;[\s\S]*?body\s*{[^}]*min-width:\s*0;/s
  );
});
