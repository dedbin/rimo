"""Check the saved owner report and render its actual PDF pages for review."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, ImageOps
from pypdf import PdfReader


def compact(text: str) -> str:
    """Normalize extraction whitespace while preserving Cyrillic letters."""
    return re.sub(r"\s+", "", text)


def pdfium_text(document: pdfium.PdfDocument) -> list[str]:
    """Extract text with an independent PDF engine."""
    output: list[str] = []
    for index in range(len(document)):
        page = document[index]
        text_page = page.get_textpage()
        output.append(text_page.get_text_range())
        text_page.close()
        page.close()
    return output


def verify_report(root: Path) -> dict[str, Any]:
    """Validate text, page count, links and image decoding, then render pages."""
    pdf_path = root / "Rimo-progress-2026-10-27.pdf"
    qa_dir = root / "qa"
    qa_dir.mkdir(exist_ok=True)
    reader = PdfReader(pdf_path)
    document = pdfium.PdfDocument(pdf_path)
    primary = [page.extract_text() or "" for page in reader.pages]
    independent = pdfium_text(document)
    assert len(primary) == len(independent) == 8, "Expected exactly eight pages"
    expected = [
        "Что уже готово в Rimo",
        "Учебный материал на одной доске",
        "Вход без лишних шагов",
        "Работа вместе и управление доступом",
        "Урок можно раздать в PDF",
        "Материалы можно забрать и восстановить",
        "Что подтверждено, а что ещё проверяется",
        "Что осталось до внешнего запуска",
    ]
    page_checks: list[dict[str, Any]] = []
    rendered: list[Path] = []
    for index, heading in enumerate(expected):
        assert compact(heading) in compact(primary[index]), f"pypdf: {index + 1}"
        assert compact(heading) in compact(independent[index]), f"PDFium: {index + 1}"
        assert "\ufffd" not in primary[index] + independent[index], "Replacement glyph"
        page = document[index]
        bitmap = page.render(scale=2)
        image = bitmap.to_pil()
        rendered_path = qa_dir / f"page-{index + 1:02d}.png"
        image.save(rendered_path)
        rendered.append(rendered_path)
        page_checks.append({
            "page": index + 1,
            "headingExtractedByBothEngines": True,
            "sizePoints": [round(float(x), 2) for x in page.get_size()],
            "renderSize": list(image.size),
        })
        image.close()
        bitmap.close()
        page.close()
    text = "\n\n".join(primary)
    for phrase in ["784", "47 мин 55 с", "59,4", "336", "300", "16 вопросов владельцу"]:
        assert compact(phrase) in compact(text), phrase
    assert not re.search(r"[\u4e00-\u9fff]", text), "Unexpected language"
    links = []
    for page in reader.pages:
        for annotation in page.get("/Annots", []):
            action = annotation.get_object().get("/A", {})
            if action.get("/URI"):
                links.append(str(action["/URI"]))
    assert any("legal-questions-2026-10-27.md" in link for link in links)
    assert any("github.com/dedbin/rimo/tree/codex/service-rework" in link for link in links)
    assert all("/invite" not in link and "#" not in link for link in links)
    for group in range(2):
        sheet = Image.new("RGB", (1224, 1712), "#dfe6ec")
        for offset in range(4):
            index = group * 4 + offset
            with Image.open(rendered[index]) as original:
                thumb = ImageOps.contain(original.convert("RGB"), (596, 842))
                sheet.paste(thumb, (8 + (offset % 2) * 612, 8 + (offset // 2) * 856))
        sheet.save(qa_dir / f"contact-{group + 1}.png")
        sheet.close()
    (qa_dir / "extracted-text.txt").write_text(text, encoding="utf-8")
    screenshots = []
    for screenshot in sorted((root / "screenshots").glob("*.png")):
        with Image.open(screenshot) as image:
            image.verify()
        screenshots.append(screenshot.name)
    demo = PdfReader(root / "assets" / "demo-lesson.pdf")
    demo_text = compact(" ".join(page.extract_text() or "" for page in demo.pages))
    assert len(demo.pages) == 2
    assert "Квадратныеуравнения" in demo_text and "Проверено" in demo_text
    document.close()
    result = {
        "pages": page_checks,
        "textExtractedByTwoEngines": True,
        "requiredFactsFound": True,
        "legalQuestionsLinkPresent": True,
        "noInvitationLinks": True,
        "screenshotsDecoded": screenshots,
        "demoPdf": {"pages": 2, "russianAndStudentTextFound": True},
        "reportBytes": pdf_path.stat().st_size,
    }
    (root / "qa-pdf.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return result


if __name__ == "__main__":
    verification = verify_report(Path(__file__).resolve().parent)
    print(json.dumps({
        "pages": len(verification["pages"]),
        "twoTextEngines": verification["textExtractedByTwoEngines"],
        "linksVerified": verification["legalQuestionsLinkPresent"],
        "bytes": verification["reportBytes"],
    }))
