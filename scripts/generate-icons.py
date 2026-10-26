"""Generate original Cutroom desktop artwork. Run: uv run --with pillow scripts/generate-icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parents[1] / "apps/desktop/assets"
(ASSETS / "tray/menu").mkdir(parents=True, exist_ok=True)


def mark(size, dock=False, busy=False):
    scale = 4
    image = Image.new("RGBA", (size * scale, size * scale))
    draw = ImageDraw.Draw(image)
    unit = size * scale / 26
    box = lambda points: tuple(round(v * unit) for v in points)
    if dock:
        draw.rounded_rectangle(box((1, 1, 25, 25)), radius=round(6 * unit), fill="#222426")
    ink = "#f2f2f2" if dock else "#000000"
    draw.rounded_rectangle(box((5, 5, 18, 17)), radius=round(2 * unit), fill=ink)
    draw.rounded_rectangle(box((7, 9, 23, 23)), radius=round(3 * unit), fill="#222426" if dock else "#ffffff00")
    draw.rounded_rectangle(box((8, 10, 23, 23)), radius=round(2 * unit), outline=ink, width=max(1, round(1.8 * unit)))
    draw.line(box((13, 14, 18, 19)), fill=ink, width=max(1, round(1.8 * unit)))
    if busy:
        draw.ellipse(box((19, 2, 25, 8)), fill=ink)
    return image.resize((size, size), Image.Resampling.LANCZOS)


icon = mark(1024, dock=True)
icon.save(ASSETS / "icon.png")
icon.save(ASSETS / "icon-dev.png")
icon.save(ASSETS / "icon.icns", format="ICNS")
icon.save(ASSETS / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
for suffix, size in [("", 18), ("@2x", 36)]:
    for name in ["idleTemplate", "busyTemplate", "win"]:
        mark(size, dock=name == "win", busy=name == "busyTemplate").save(ASSETS / f"tray/{name}{suffix}.png")
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
print(f"Generated original artwork in {ASSETS}")
