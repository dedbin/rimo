"""Verify a PDF printed from an archive restored into a new database."""

import argparse
import json
import re
from pathlib import Path
from typing import Sequence

import pdfplumber
from pypdf import PdfReader


def verify_archive_pdf(filename: Path) -> dict[str, object]:
    reader = PdfReader(filename)
    assert len(reader.pages) == 2, "Restored archive must print two pages"
    names = ("Домашняя работа", "Урок")
    phrases = (
        "Домашняя задача после восстановления",
        "Русский текст после восстановления",
    )
    for index, page in enumerate(reader.pages):
        text = re.sub(r"\s+", " ", page.extract_text() or "")
        assert text.startswith(names[index]), f"pypdf: wrong restored page order at {index + 1}"
        assert phrases[index] in text, f"pypdf: missing restored Russian text on {index + 1}"
    with pdfplumber.open(filename) as document:
        for index, page in enumerate(document.pages):
            text = re.sub(r"\s+", " ", page.extract_text() or "")
            assert text.startswith(names[index]), f"pdfminer: wrong restored page order at {index + 1}"
            assert phrases[index] in text, f"pdfminer: missing restored Russian text on {index + 1}"
        lesson = document.pages[1]
        lesson_text = lesson.extract_text() or ""
        assert "Уравнение архива" in lesson_text, "Restored rich-text heading is not searchable"
        assert all(symbol in lesson_text for symbol in ("x", "y", "25")), "Restored formula is missing"
        assert lesson.images, "pdfminer: restored image is missing from lesson page"
        assert not document.pages[0].images, "Restored image must stay on its own frame"
    assert len(reader.pages[1].images) > 0, "pypdf: restored image is missing"
    first, second = (page.mediabox for page in reader.pages)
    assert float(first.height) > float(first.width), "First restored page must be portrait"
    assert float(second.width) > float(second.height), "Second restored page must be landscape"
    return {
        "pages": 2,
        "independent_text_engines": ["pypdf", "pdfminer"],
        "restored_frame_order": list(names),
        "russian_text_and_math_searchable": True,
        "restored_image_in_correct_frame": True,
    }


def main(arguments: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    options = parser.parse_args(arguments)
    print(json.dumps(verify_archive_pdf(options.pdf), ensure_ascii=True))


if __name__ == "__main__":
    main()
