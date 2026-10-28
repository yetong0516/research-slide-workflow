#!/usr/bin/env python3
"""Read-only checks for raster fallbacks attached to SVG pictures in a PPTX.

Uses only the Python standard library. Only pictures in slides used by the
presentation, and their used layouts/masters, are checked. PNG alpha inspection
supports non-interlaced, 8-bit PNGs; other encodings are reported as unverified.
"""

import argparse
import json
import posixpath
import struct
import sys
import zipfile
import zlib
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote, urlsplit

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "svg": "http://schemas.microsoft.com/office/drawing/2016/SVG/main",
}
EMBED = "{" + NS["r"] + "}embed"
REL_ID = "{" + NS["r"] + "}id"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_DECODED_PNG = 64 * 1024 * 1024


def resolve_target(source_part, target):
    """Resolve an internal OPC relationship URI against its source part."""
    uri = urlsplit(target)
    if uri.scheme or uri.netloc or uri.query or uri.fragment:
        raise ValueError("Relationship target is not an internal package part")
    target_path = unquote(uri.path)
    if not target_path or "\\" in target_path:
        raise ValueError("Invalid package part target")
    joined = target_path.lstrip("/") if target_path.startswith("/") else posixpath.join(posixpath.dirname(source_part), target_path)
    normalized = posixpath.normpath(joined)
    if normalized in {"", ".", ".."} or normalized.startswith("../"):
        raise ValueError("Relationship target escapes the package")
    return normalized


def relationships(archive, part):
    rels_part = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    if rels_part not in archive.namelist():
        return {}
    return {entry.attrib["Id"]: entry.attrib for entry in ET.fromstring(archive.read(rels_part)) if "Id" in entry.attrib}


def used_drawing_parts(archive):
    """Follow used slides to their layouts/masters, without scanning orphan parts."""
    presentation = "ppt/presentation.xml"
    root = ET.fromstring(archive.read(presentation))
    rels = relationships(archive, presentation)
    queue = []
    for slide in root.findall("./p:sldIdLst/p:sldId", NS):
        rel = rels.get(slide.attrib.get(REL_ID), {})
        if rel.get("TargetMode") == "External" or not rel.get("Target"):
            raise ValueError("A used slide has no internal package relationship")
        queue.append((resolve_target(presentation, rel["Target"]), "slide"))
    seen = set()
    while queue:
        part, kind = queue.pop(0)
        if part in seen:
            continue
        seen.add(part)
        if part not in archive.namelist():
            raise ValueError("Used drawing part is missing: " + part)
        yield part
        next_kind = {"slide": "slideLayout", "slideLayout": "slideMaster"}.get(kind)
        if next_kind:
            for rel in relationships(archive, part).values():
                if rel.get("Type", "").endswith("/" + next_kind) and rel.get("TargetMode") != "External":
                    queue.append((resolve_target(part, rel["Target"]), next_kind))


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def png_header(data):
    """Retain trustworthy dimensions even if a later PNG chunk is damaged."""
    if len(data) < 33 or not data.startswith(PNG_SIGNATURE) or data[8:16] != b"\x00\x00\x00\rIHDR":
        return {}
    if struct.unpack_from(">I", data, 29)[0] != zlib.crc32(data[12:29]) & 0xffffffff:
        return {}
    width, height, depth, color = struct.unpack_from(">IIBB", data, 16)
    return {"width": width, "height": height, "bitDepth": depth,
            "colorType": color, "verified": False}


def inspect_png(data):
    """Return dimensions and, when supported, whether every pixel is transparent."""
    if not data.startswith(PNG_SIGNATURE):
        return {"verified": False, "reason": "Fallback is not a supported PNG"}
    offset, header, compressed, transparency, palette = 8, None, bytearray(), None, None
    ended = False
    while offset + 12 <= len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        end = offset + 12 + size
        if end > len(data):
            raise ValueError("Truncated PNG chunk")
        kind, chunk = data[offset + 4:offset + 8], data[offset + 8:offset + 8 + size]
        crc = struct.unpack_from(">I", data, offset + 8 + size)[0]
        if zlib.crc32(kind + chunk) & 0xffffffff != crc:
            raise ValueError("PNG chunk checksum mismatch")
        if header is None and kind != b"IHDR":
            raise ValueError("PNG does not begin with IHDR")
        if kind == b"IHDR":
            if header is not None or len(chunk) != 13:
                raise ValueError("Invalid PNG header")
            header = struct.unpack(">IIBBBBB", chunk)
        elif kind == b"IDAT":
            compressed.extend(chunk)
        elif kind == b"tRNS":
            transparency = chunk
        elif kind == b"PLTE":
            palette = chunk
        elif kind == b"IEND":
            ended = True
            break
        offset = end
    if header is None or not ended or not compressed:
        raise ValueError("Incomplete PNG")
    width, height, depth, color, compression, filtering, interlace = header
    if not width or not height:
        raise ValueError("PNG has zero dimensions")
    result = {"width": width, "height": height, "bitDepth": depth,
              "colorType": color, "verified": False}
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
    if depth != 8 or channels is None or compression != 0 or filtering != 0 or interlace != 0:
        return {**result, "reason": "Only non-interlaced 8-bit PNG alpha inspection is supported"}
    stride = width * channels
    expected = height * (stride + 1)
    if expected > MAX_DECODED_PNG:
        return {**result, "reason": "PNG exceeds the inspection size limit"}
    decoder = zlib.decompressobj()
    raw = decoder.decompress(bytes(compressed), expected + 1)
    if len(raw) != expected or not decoder.eof or decoder.unused_data:
        raise ValueError("PNG pixel stream has an invalid length")
    if color == 3 and (not palette or len(palette) % 3 or len(palette) > 768):
        raise ValueError("Indexed PNG has an invalid palette")
    if transparency is not None:
        if color in (4, 6) or (color == 0 and len(transparency) != 2) or (color == 2 and len(transparency) != 6):
            raise ValueError("Invalid PNG transparency chunk")
        if color == 3 and len(transparency) > len(palette) // 3:
            raise ValueError("Indexed PNG transparency exceeds its palette")
    transparent_gray = struct.unpack(">H", transparency)[0] if color == 0 and transparency is not None else None
    transparent_rgb = struct.unpack(">HHH", transparency) if color == 2 and transparency is not None else None
    previous = bytearray(stride)
    all_transparent = True
    for y in range(height):
        start = y * (stride + 1)
        filter_type, row = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        if filter_type > 4:
            raise ValueError("Unsupported PNG row filter")
        if filter_type:
            for i in range(stride):
                a = row[i - channels] if i >= channels else 0
                b = previous[i]
                c = previous[i - channels] if i >= channels else 0
                predictor = (0, a, b, (a + b) // 2, _paeth(a, b, c))[filter_type]
                row[i] = (row[i] + predictor) & 255
        if color in (4, 6):
            all_transparent = all_transparent and not any(row[channels - 1::channels])
            previous = row
            continue
        for x in range(width):
            pixel = row[x * channels:(x + 1) * channels]
            if color == 3:
                index = pixel[0]
                if index >= len(palette) // 3:
                    raise ValueError("PNG pixel references a missing palette entry")
                alpha = transparency[index] if transparency is not None and index < len(transparency) else 255
            elif color == 0:
                alpha = 0 if pixel[0] == transparent_gray else 255
            else:
                alpha = 0 if tuple(pixel) == transparent_rgb else 255
            all_transparent = all_transparent and alpha == 0
        previous = row
    return {**result, "verified": True, "fullyTransparent": all_transparent}


def inspect_pptx_images(filename):
    pictures = []
    with zipfile.ZipFile(filename) as archive:
        names = set(archive.namelist())
        for part in used_drawing_parts(archive):
            rels = relationships(archive, part)
            root = ET.fromstring(archive.read(part))
            for index, picture in enumerate(root.findall(".//p:pic", NS), 1):
                blip = picture.find("./p:blipFill/a:blip", NS)
                if blip is None or not blip.findall(".//svg:svgBlip", NS):
                    continue
                props = picture.find("./p:nvPicPr/p:cNvPr", NS)
                row = {"part": part, "pictureIndex": index,
                       "pictureName": props.attrib.get("name", "") if props is not None else "",
                       "fallbackRelationshipId": blip.attrib.get(EMBED), "svgParts": [], "issues": []}
                def issue(code, message, severity="error"):
                    row["issues"].append({"code": code, "severity": severity, "message": message})
                for svg in blip.findall(".//svg:svgBlip", NS):
                    rel = rels.get(svg.attrib.get(EMBED), {})
                    if rel.get("Target") and rel.get("TargetMode") != "External":
                        try:
                            target = resolve_target(part, rel["Target"])
                            row["svgParts"].append(target)
                            if target not in names:
                                issue("missing_svg_part", "Referenced SVG part is missing")
                        except ValueError as exc:
                            issue("invalid_svg_relationship", str(exc))
                    else:
                        issue("missing_svg_relationship", "SVG has no embedded internal relationship")
                rel_id = row["fallbackRelationshipId"]
                fallback = rels.get(rel_id, {})
                if not rel_id:
                    issue("missing_fallback", "SVG picture has no embedded raster fallback")
                elif not fallback.get("Target"):
                    issue("missing_fallback_relationship", "Raster fallback relationship is missing")
                elif fallback.get("TargetMode") == "External":
                    issue("external_fallback", "Raster fallback is external, not embedded")
                else:
                    try:
                        target = resolve_target(part, fallback["Target"])
                        row["fallbackPart"] = target
                        if target not in names:
                            issue("missing_fallback_part", "Raster fallback part is missing")
                        else:
                            data = archive.read(target)
                            header = png_header(data)
                            if header:
                                row["png"] = header
                            if header.get("width") == 1 and header.get("height") == 1:
                                issue("one_pixel_fallback", "SVG raster fallback is only 1 by 1 pixel")
                            png = inspect_png(data)
                            row["png"] = png
                            if png.get("fullyTransparent"):
                                issue("transparent_fallback", "SVG raster fallback is fully transparent")
                            if not png["verified"]:
                                issue("unverified_fallback", png["reason"], "warning")
                    except (ValueError, zlib.error) as exc:
                        issue("invalid_fallback", str(exc))
                row["status"] = "error" if any(i["severity"] == "error" for i in row["issues"]) else "unverified" if row["issues"] else "valid"
                pictures.append(row)
    return {"svgPictureCount": len(pictures),
            "validCount": sum(p["status"] == "valid" for p in pictures),
            "errorCount": sum(i["severity"] == "error" for p in pictures for i in p["issues"]),
            "warningCount": sum(i["severity"] == "warning" for p in pictures for i in p["issues"]),
            "pictures": pictures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--fail-on-error", action="store_true", help="Exit 1 for confirmed fallback errors; unsupported encodings remain unverified warnings")
    args = parser.parse_args()
    try:
        report = inspect_pptx_images(args.pptx)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, ET.ParseError) as exc:
        parser.exit(2, "Could not inspect PPTX: " + str(exc) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if args.fail_on_error and report["errorCount"] else 0


if __name__ == "__main__":
    sys.exit(main())
