"""Draw the tray menu glyphs and the Windows manifest. Run: uv run --with pillow scripts/generate-icons.py

The app icon, icon.ico and the tray marks come from apps/desktop/assets/icon.svg: npm run make:icon."""
from pathlib import Path
from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parents[1] / "apps/desktop/assets"
(ASSETS / "tray/menu").mkdir(parents=True, exist_ok=True)

for suffix, size in [("", 18), ("@2x", 36)]:
    for name in ["open", "hide", "ready", "busy", "project", "quit"]:
        image = Image.new("RGBA", (size * 4, size * 4))
        draw = ImageDraw.Draw(image)
        u = size / 4
        xy = lambda coords: tuple(round(v * u) for v in coords)
        stroke = max(1, round(1.3 * u))
        if name in ["open", "project"]:
            draw.rounded_rectangle(xy((2, 3, 14, 13)), radius=round(u), outline="black", width=stroke)
            draw.line(xy((2, 6, 14, 6)), fill="black", width=stroke)
        elif name == "hide":
            draw.line(xy((3, 9, 13, 9)), fill="black", width=stroke)
        elif name == "ready":
            draw.line(xy((3, 8, 7, 12, 14, 4)), fill="black", width=stroke)
        elif name == "busy":
            draw.arc(xy((3, 3, 13, 13)), 25, 320, fill="black", width=stroke)
        else:
            draw.arc(xy((3, 3, 13, 13)), -50, 230, fill="black", width=stroke)
            draw.line(xy((8, 1, 8, 8)), fill="black", width=stroke)
        image.resize((size, size), Image.Resampling.LANCZOS).save(ASSETS / f"tray/menu/{name}{suffix}.png")

(ASSETS / "app.manifest").write_text('''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" name="Cutroom" type="win32"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>
    <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
  </requestedPrivileges></security></trustInfo>
</assembly>
''')
print(f"Generated tray menu glyphs in {ASSETS}")
