"""Verify exported PDF text, paper dimensions and page order with pypdf."""

import argparse
import json
import re
from pathlib import Path
from typing import Sequence

import pdfplumber
from pypdf import PdfReader


def verify_pdf(filename: Path, expected_pages: int) -> dict[str, object]:
    reader = PdfReader(filename)
    assert len(reader.pages) == expected_pages, "Unexpected PDF page count"
    texts = [re.sub(r"\s+", " ", page.extract_text()) for page in reader.pages]
    for index, text in enumerate(texts):
        assert "Квадратное уравнение" in text, f"Page {index + 1}: Cyrillic heading is not searchable"
        assert "Найдите корни и объясните решение" in text, f"Page {index + 1}: Russian paragraph is not copyable"
        expected_name = "Задача" if index == 0 else f"Решение {index}"
        assert text.startswith(expected_name), f"Page {index + 1}: incorrect page order"
    with pdfplumber.open(filename) as document:
        for index, page in enumerate(document.pages):
            text = page.extract_text() or ""
            assert "Квадратное уравнение" in text, f"Page {index + 1}: pdfminer cannot find an intact Cyrillic phrase"
            assert "Найдите корни и объясните решение." in text, f"Page {index + 1}: pdfminer cannot copy an intact Russian sentence"
            for phrase in ("Шрифт с засечками", "Моноширинный текст", "Жирный курсив", "код_по_русски = 3", "печать(2 + 3)"):
                assert phrase in text, f"Page {index + 1}: missing exact Cyrillic font/style phrase: {phrase}"
    first = reader.pages[0].mediabox
    assert float(first.height) > float(first.width), "First page must be portrait A4"
    if expected_pages > 1:
        second = reader.pages[1].mediabox
        assert float(second.width) > float(second.height), "Second page must be landscape A3"
    return {
        "pages": len(reader.pages),
        "russian_text_searchable": True,
        "russian_text_copyable": True,
        "page_order_verified": True,
        "independent_pdfminer_exact_phrases": True,
        "paper_sizes_pt": [[round(float(page.mediabox.width), 2), round(float(page.mediabox.height), 2)] for page in reader.pages[:2]],
    }


def main(arguments: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--pages", type=int, default=20)
    options = parser.parse_args(arguments)
    print(json.dumps(verify_pdf(options.pdf, options.pages), ensure_ascii=True))


if __name__ == "__main__":
    main()
