"""The fixed set of refusals. Each kind always looks the same to the caller."""

from django.http import JsonResponse


def bad_request():
    return JsonResponse({"detail": "Bad request."}, status=400)


def sign_in_failed():
    return JsonResponse({"detail": "Sign-in failed."}, status=401)


def not_signed_in():
    return JsonResponse({"detail": "Not signed in."}, status=401)


def forbidden():
    return JsonResponse({"detail": "Forbidden."}, status=403)


def elevation_required():
    return JsonResponse(
        {"detail": "Confirm with your passkey.", "code": "elevation_required"},
        status=403,
    )


def not_found():
    return JsonResponse({"detail": "Not found."}, status=404)


def conflict():
    return JsonResponse({"detail": "Not possible right now."}, status=409)


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
