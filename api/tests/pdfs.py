"""Small PDF files for the CV tests, built by hand so no library is needed."""

import io
import zipfile


def pdf(catalog=b"", trailer=b"", body=b"", stream=b"BT /F1 12 Tf (CV) Tj ET"):
    """A minimal one-page PDF. catalog and trailer add entries to those
    dictionaries; body adds objects; stream is the page's content."""
    return b"".join(
        [
            b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n",
            b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R " + catalog + b">>\nendobj\n",
            b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n",
            b"4 0 obj\n<< /Length %d >>\nstream\n" % len(stream),
            stream,
            b"\nendstream\nendobj\n",
            body,
            b"xref\n0 5\n0000000000 65535 f \n",
            b"trailer\n<< /Size 5 /Root 1 0 R " + trailer + b">>\n",
            b"startxref\n0\n%%EOF\n",
        ]
    )


GOOD = pdf()


def zip_with_pdf_header():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", "<w:document/>")
    return b"%PDF-1.7\n" + buffer.getvalue() + b"\n%%EOF\n"


def encrypted():
    return pdf(
        trailer=b"/Encrypt 5 0 R /ID [<00><00>] ",
        body=b"5 0 obj\n<< /Filter /Standard /V 2 /R 3 /O <00> /U <00> /P -4 >>\n"
        b"endobj\n",
    )


def with_javascript():
    return pdf(
        catalog=b"/Names << /JavaScript 5 0 R >> ",
        body=b"5 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj\n",
    )


def with_hidden_javascript():
    # #4A is J: the same name written with a hex escape.
    return pdf(catalog=b"/Names << /#4AavaScript 5 0 R >> ")


ACTIVE = {
    "javascript": with_javascript(),
    "hex escaped name": with_hidden_javascript(),
    "open action": pdf(catalog=b"/OpenAction 3 0 R "),
    "additional actions": pdf(catalog=b"/AA << /O 3 0 R >> "),
    "launch": pdf(body=b"5 0 obj\n<< /S /Launch /F (calc.exe) >>\nendobj\n"),
    "embedded file": pdf(
        body=b"5 0 obj\n<< /Type /EmbeddedFile /Length 0 >>\nstream\n\n"
        b"endstream\nendobj\n"
    ),
}
