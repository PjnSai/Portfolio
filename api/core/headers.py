"""The API's security headers. This is the only place they are defined.

The API serves JSON only, so the policy allows nothing: no scripts, no frames,
no forms.
"""

HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; "
        "form-action 'none'"
    ),
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": (
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), "
        "magnetometer=(), microphone=(), payment=(), usb=()"
    ),
}

HIDDEN = ("Server", "X-Powered-By")


class SecurityHeadersMiddleware:
    """Outermost middleware, so error responses get the headers too."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        for name, value in HEADERS.items():
            response[name] = value
        # Nothing is cached unless a view opts in by setting Cache-Control.
        response.setdefault("Cache-Control", "no-store")
        for name in HIDDEN:
            del response[name]
        return response
