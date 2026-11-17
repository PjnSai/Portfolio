from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


# Read-only, like the DRF views, which DRF exempts itself.
@csrf_exempt
@require_GET
def healthz(request):
    return JsonResponse({"status": "ok"}, headers={"Cache-Control": "no-store"})


@api_view(["GET"])
@permission_classes([AllowAny])
def status(request):
    return Response({"status": "ok"}, headers={"Cache-Control": "no-store"})
