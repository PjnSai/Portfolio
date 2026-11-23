from django.urls import path

from core import contact_views, media_views, views

urlpatterns = [
    path("status", views.status),
    path("site", media_views.public_site),
    path("media/<str:name>", media_views.public_file),
    path("contact", contact_views.submit),
    path("contact/challenge", contact_views.challenge),
]
