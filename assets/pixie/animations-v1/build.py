"""Package imagegen's 4x2 animation sheets. Run with Pillow installed."""
from pathlib import Path
import json
import shutil
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageSequence

ROOT = Path(__file__).resolve().parent
# The renderer's public dir; the app consumes exactly the webp animation and
# the png poster of each state from here (see PixieSprite.vue).
APP_ASSETS = ROOT.parents[2] / "resources" / "pixie"
SIZE = 256
STATES = {
    "idle": ("待机", [1000, 180, 220, 80, 100, 100, 240, 350]),
    "wave": ("招手", [650, 120, 120, 140, 140, 140, 120, 450]),
    "think": ("思考", [600, 180, 250, 350, 650, 250, 180, 400]),
    "happy": ("开心", [600, 100, 120, 180, 320, 140, 140, 450]),
    "sleep": ("休息", [450, 450, 450, 500, 450, 450, 450, 500]),
}


def extract(sheet):
    frames = []
    for i in range(8):
        x, y = i % 4, i // 4
        cell = sheet.crop((round(x * sheet.width / 4), round(y * sheet.height / 2),
                           round((x + 1) * sheet.width / 4), round((y + 1) * sheet.height / 2)))
        # Keep the connected character, removing isolated alpha noise in the generated sheet.
        alpha = cell.getchannel("A")
        mask = alpha.point(lambda a: 255 if a >= 180 else 0)
        seed = (cell.width // 2, cell.height // 2)
        assert mask.getpixel(seed) == 255, "Expected character at the center of its grid cell"
        ImageDraw.floodfill(mask, seed, 128)
        core = mask.point(lambda a: 255 if a == 128 else 0)
        bounds = core.getbbox()
        assert bounds and (bounds[2] - bounds[0]) > cell.width * .4
        cell.putalpha(ImageChops.multiply(alpha, core.filter(ImageFilter.MaxFilter(5))))
        frames.append(cell.crop(cell.getbbox()))
    return frames


def build():
    manifest = {"size": [SIZE, SIZE], "loop": 0, "source": "imagegen keyframes based on pixie-concept-v6.png", "states": {}}
    contact = Image.new("RGB", (8 * 144, 5 * 166), "#edf3f8")
    draw = ImageDraw.Draw(contact)
    for row, (name, (label, durations)) in enumerate(STATES.items()):
        source = Image.open(ROOT / "sources" / f"{name}.png").convert("RGBA")
        cropped = extract(source)
        # One scale for the whole sequence preserves the relative sizes of animation poses.
        scale = min(210 / max(f.height for f in cropped), 218 / max(f.width for f in cropped))
        frames = []
        for i, frame in enumerate(cropped):
            frame = frame.resize((round(frame.width * scale), round(frame.height * scale)), Image.Resampling.LANCZOS)
            canvas = Image.new("RGBA", (SIZE, SIZE))
            canvas.alpha_composite(frame, ((SIZE - frame.width) // 2, (SIZE - frame.height) // 2))
            frames.append(canvas)
            thumb = canvas.resize((140, 140), Image.Resampling.LANCZOS)
            contact.paste(thumb, (i * 144 + 2, row * 166 + 20), thumb)
            draw.text((i * 144 + 8, row * 166 + 4), f"{name} {i + 1}", fill="#24394d")
        frames[0].save(ROOT / f"{name}.png")
        frames[0].save(ROOT / f"{name}.webp", save_all=True, append_images=frames[1:],
                       duration=durations, loop=0, lossless=True, method=6)
        # Shared palette avoids frame-to-frame palette changes. Index 255 is transparent.
        colors = Image.new("RGB", (SIZE * 8, SIZE), "#d9eaf3")
        for i, frame in enumerate(frames):
            colors.paste(frame, (i * SIZE, 0), frame)
        palette = colors.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
        gif_frames = []
        for frame in frames:
            rgb = Image.new("RGB", frame.size, "#d9eaf3")
            rgb.paste(frame, mask=frame.getchannel("A"))
            indexed = rgb.quantize(palette=palette, dither=Image.Dither.NONE)
            indexed.paste(255, mask=frame.getchannel("A").point(lambda a: 255 if a < 128 else 0))
            indexed.info["transparency"] = 255
            gif_frames.append(indexed)
        gif_frames[0].save(ROOT / f"{name}.gif", save_all=True, append_images=gif_frames[1:],
                          duration=durations, loop=0, transparency=255, disposal=2, optimize=False)
        sheet = Image.new("RGBA", (SIZE * 8, SIZE))
        for i, frame in enumerate(frames):
            sheet.alpha_composite(frame, (i * SIZE, 0))
        sheet.save(ROOT / f"{name}-strip.png")
        manifest["states"][name] = {"label": label, "frames": 8, "durationsMs": durations,
                                    "durationMs": sum(durations), "webp": f"{name}.webp",
                                    "gif": f"{name}.gif", "poster": f"{name}.png", "strip": f"{name}-strip.png"}
        for suffix in ("gif", "webp"):
            with Image.open(ROOT / f"{name}.{suffix}") as animation:
                assert animation.n_frames == 8, (name, suffix, animation.n_frames)
                assert animation.info["loop"] == 0
                decoded = [f.convert("RGBA") for f in ImageSequence.Iterator(animation)]
                assert all(f.size == (SIZE, SIZE) and f.getpixel((0, 0))[3] == 0 for f in decoded)
                assert len({f.tobytes() for f in decoded}) >= 6, "Animation must contain real distinct frames"
                if suffix == "gif":
                    animation.seek(0)
                    assert sum(f.info["duration"] for f in ImageSequence.Iterator(animation)) == sum(durations)
        print(f"Verified {name}: 8 frames, {sum(durations)}ms, transparent GIF + WebP")
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    contact.save(ROOT / "contact-sheet.jpg", quality=92)
    deploy()


def deploy():
    """Sync the formats the app consumes into resources/pixie after a rebuild."""
    if not APP_ASSETS.is_dir():
        print(f"Skipped deploy: {APP_ASSETS} does not exist (not inside a PiX checkout)")
        return
    for name in STATES:
        for suffix in ("webp", "png"):
            shutil.copy2(ROOT / f"{name}.{suffix}", APP_ASSETS / f"{name}.{suffix}")
    print(f"Deployed {len(STATES) * 2} files to {APP_ASSETS}")


if __name__ == "__main__":
    build()
