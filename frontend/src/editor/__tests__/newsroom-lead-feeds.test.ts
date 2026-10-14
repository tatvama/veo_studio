/** News Room data: feed text cleaning and JSON paths with odd keys (feeds/feed.ts plainText, feeds/json.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainText } from "../newsroom/feeds/feed.ts";
import { getPath, parsePath } from "../newsroom/feeds/json.ts";

test("plainText removes tags until none are left, scripts and styles with their contents", () => {
  assert.equal(plainText("<p>Rain <b>alert</b></p><script>x()</script>for Mumbai"), "Rain alert for Mumbai");
  assert.equal(plainText("x <style >p{}</style > y"), "x y");
  // broken or nested tags: whatever is left holds no tag at all
  for (const s of ["a<scr<b>ipt>bad()</script>b", "<<script>script>alert(1)<</script>/script>", "<img src=x onerror=1><b>ok</b>"]) {
    assert.ok(!/<\/?[a-z]/i.test(plainText(s)), plainText(s));
  }
});

test("a JSON key with quotes and backslashes round-trips through a path", () => {
  const key = 'a "quoted" \\ key';
  const v = { [key]: { items: [1, 2] } };
  const path = `["${key.replace(/[\\"]/g, "\\$&")}"].items`;
  assert.deepEqual(parsePath(path), [key, "items"]);
  assert.deepEqual(getPath(v, path), [1, 2]);
});
