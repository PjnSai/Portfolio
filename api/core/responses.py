"""The fixed set of refusals. Each kind always looks the same to the caller."""

from django.http import JsonResponse


def bad_request():
    return JsonResponse({"detail": "Bad request."}, status=400)


def invalid(errors):
    """A form the owner filled in wrongly, with a message for each field."""
    return JsonResponse(
        {"detail": "Some fields need changing.", "errors": errors}, status=400
    )


def sign_in_failed():
    return JsonResponse({"detail": "Sign-in failed."}, status=401)


def not_signed_in():
    return JsonResponse({"detail": "Not signed in."}, status=401)


def forbidden():
    return JsonResponse({"detail": "Forbidden."}, status=403)


def csrf_failure(request, reason=""):
    return forbidden()


def elevation_required():
    return JsonResponse(
        {"detail": "Confirm with your passkey.", "code": "elevation_required"},
        status=403,
    )


def not_found():
    return JsonResponse({"detail": "Not found."}, status=404)


def conflict(code=None):
    """code, if given, names the rule so the admin can explain it."""
    body = {"detail": "Not possible right now."}
    if code:
        body["code"] = code
    return JsonResponse(body, status=409)


def privacy_check(warnings):
    """Publishing would put contact details on the site; ask the owner first."""
    return JsonResponse(
        {
            "detail": "This text looks like it holds contact details.",
            "code": "privacy_check",
            "warnings": warnings,
        },
        status=409,
    )


def contact_sent():
    """The one answer to a message that was saved, whether it went to the inbox
    or to quarantine: nothing here lets a sender tell which."""
    return JsonResponse(
        {"detail": "Thank you. Your message has been received."},
        status=201,
        headers={"Cache-Control": "no-store"},
    )


def bad_challenge():
    return JsonResponse(
        {
            "detail": "The anti-spam check did not pass. Please try again.",
            "code": "challenge",
        },
        status=400,
    )


def contact_limited(retry_after):
    """The same for the address, email and daily limits."""
    return JsonResponse(
        {
            "detail": "Too many messages. Please try again later.",
            "code": "rate_limited",
        },
        status=429,
        headers={"Retry-After": str(max(1, int(retry_after)))},
    )


def too_large():
    return JsonResponse({"detail": "Too large."}, status=413)


def method_not_allowed(methods):
    return JsonResponse(
        {"detail": "Method not allowed."},
        status=405,
        headers={"Allow": ", ".join(methods)},
    )


def too_many_requests(retry_after):
    return JsonResponse(
        {"detail": "Too many requests."},
        status=429,
        headers={"Retry-After": str(max(1, int(retry_after)))},
    )


def unavailable():
    return JsonResponse({"detail": "Service unavailable."}, status=503)
