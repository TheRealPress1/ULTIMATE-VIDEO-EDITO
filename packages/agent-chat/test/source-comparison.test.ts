/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from "vitest";
import { comparableSource } from "../src/host/source-comparison";
const compare = (source: string) => comparableSource("index.tsx", source);

describe("view state comparison", () => {
  it("ignores literal JSX view state but preserves composition attributes", () => {
    const before = 'export default <stage camera={[1, 0, 0, 1, 0, 0]}><scene active playhead={2} width={1920}><text selected>Title</text></scene></stage>';
    const viewed = 'export default <stage camera={[0.5, 0, 0, 0.5, -20, 20]}><scene playhead={12} width={1920} timeline={{ zoom: 2, x: 10 }}><text>Title</text></scene></stage>';
    expect(compare(before)).toBe(compare(viewed));
    expect(compare(viewed.replace('width={1920}', 'width={1080}'))).not.toBe(compare(before));
  });

  it("does not ignore matching words in title text, strings, comments, or executable expressions", () => {
    const source = 'const caption = "camera={1}"; export default <scene><text>playhead={1}</text></scene>; // active';
    expect(compare(source)).not.toBe(compare(source.replace('camera={1}', 'camera={2}')));
    expect(compare(source)).not.toBe(compare(source.replace('playhead={1}', 'playhead={2}')));
    expect(compare(source)).not.toBe(compare(source.replace('// active', '// inactive')));
    expect(compare('export default <scene playhead={readState()} />')).not.toBe(compare('export default <scene />'));
    expect(compare('export default <Custom camera={1} />')).not.toBe(compare('export default <Custom camera={2} />'));
  });

  it.each(["captions", "sequence", "adjustmentLayer"])("allows view navigation on %s while preserving its content edits", (tag) => {
    const source = `export default <${tag} id="clip" src="captions.json" />`;
    expect(compare(source)).toBe(compare(source.replace('src=', 'selected expanded clipHeight={80} src=')));
    expect(compare(source)).not.toBe(compare(source.replace("captions.json", "new-captions.json")));
  });

  it("keeps an unparseable file exact", () => {
    const source = 'export default <scene camera={';
    expect(compare(source)).toBe(source);
  });
});
