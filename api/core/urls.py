from django.urls import path

from core import contact_views, cv_views, media_views, views

urlpatterns = [
    path("status", views.status),
    path("site", media_views.public_site),
    path("media/<str:name>", media_views.public_file),
    path("contact", contact_views.submit),
    path("cv", cv_views.public_status),
    path("cv/link", cv_views.public_link),
    path("cv/file/<str:token>", cv_views.public_file),
    path("cv/request", cv_views.public_request),
]
