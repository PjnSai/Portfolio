import uuid

from django.db import models
from django.utils import timezone


class Base(models.Model):
    """Every table gets a random UUID key, never a sequential integer."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    class Meta:
        abstract = True

    def __str__(self):
        return f"{self._meta.db_table}:{self.id}"


class Timestamped(Base):
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class SiteSettings(Timestamped):
    draft = models.JSONField(default=dict)
    published = models.JSONField(default=dict)
    published_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "site_settings"


class Section(Timestamped):
    type = models.CharField(max_length=40)
    position = models.PositiveIntegerField(default=0)
    visible = models.BooleanField(default=True)
    draft = models.JSONField(default=dict)
    published = models.JSONField(default=dict)
    published_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "sections"
        ordering = ["position"]


class Tag(Base):
    slug = models.SlugField(max_length=60, unique=True)
    name = models.CharField(max_length=60)

    class Meta:
        db_table = "tags"
        ordering = ["name"]


class Media(Base):
    storage_key = models.CharField(max_length=255, unique=True)
    content_type = models.CharField(max_length=100)
    size = models.PositiveBigIntegerField()
    sha256 = models.CharField(max_length=64)
    width = models.PositiveIntegerField(null=True, blank=True)
    height = models.PositiveIntegerField(null=True, blank=True)
    alt = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    trashed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "media"


class Project(Timestamped):
    class Status(models.TextChoices):
        DRAFT = "draft"
        PUBLISHED = "published"

    slug = models.SlugField(max_length=120, unique=True)
    title = models.CharField(max_length=200)
    summary = models.TextField(blank=True)
    body = models.TextField(blank=True)
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.DRAFT
    )
    featured = models.BooleanField(default=False)
    position = models.PositiveIntegerField(default=0)
    published_at = models.DateTimeField(null=True, blank=True)
    trashed_at = models.DateTimeField(null=True, blank=True)
    tags = models.ManyToManyField(Tag, through="ProjectTag", related_name="projects")

    class Meta:
        db_table = "projects"
        ordering = ["position"]


class ProjectImage(Base):
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="images"
    )
    media = models.ForeignKey(Media, on_delete=models.PROTECT, related_name="+")
    caption = models.CharField(max_length=300, blank=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "project_images"
        ordering = ["position"]


class ProjectField(Base):
    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="fields"
    )
    label = models.CharField(max_length=100)
    value = models.TextField()
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "project_fields"
        ordering = ["position"]


class ProjectTag(Base):
    project = models.ForeignKey(Project, on_delete=models.CASCADE)
    tag = models.ForeignKey(Tag, on_delete=models.CASCADE)

    class Meta:
        db_table = "project_tags"
        constraints = [
            models.UniqueConstraint(
                fields=["project", "tag"], name="project_tags_unique"
            )
        ]


class Experience(Timestamped):
    organisation = models.CharField(max_length=200)
    role = models.CharField(max_length=200)
    location = models.CharField(max_length=200, blank=True)
    start_date = models.DateField()
    end_date = models.DateField(null=True, blank=True)
    summary = models.TextField(blank=True)
    position = models.PositiveIntegerField(default=0)
    visible = models.BooleanField(default=True)

    class Meta:
        db_table = "experience"
        ordering = ["position"]


class Education(Timestamped):
    institution = models.CharField(max_length=200)
    qualification = models.CharField(max_length=200)
    start_date = models.DateField()
    end_date = models.DateField(null=True, blank=True)
    summary = models.TextField(blank=True)
    position = models.PositiveIntegerField(default=0)
    visible = models.BooleanField(default=True)

    class Meta:
        db_table = "education"
        ordering = ["position"]


class SkillGroup(Base):
    name = models.CharField(max_length=100)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "skill_groups"
        ordering = ["position"]


class Skill(Base):
    group = models.ForeignKey(
        SkillGroup, on_delete=models.CASCADE, related_name="skills"
    )
    name = models.CharField(max_length=100)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "skills"
        ordering = ["position"]


class Link(Base):
    label = models.CharField(max_length=100)
    url = models.URLField(max_length=500)
    kind = models.CharField(max_length=40, blank=True)
    position = models.PositiveIntegerField(default=0)
    visible = models.BooleanField(default=True)

    class Meta:
        db_table = "links"
        ordering = ["position"]


class CvFile(Base):
    storage_key = models.CharField(max_length=255, unique=True)
    sha256 = models.CharField(max_length=64)
    size = models.PositiveBigIntegerField()
    is_current = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)
    trashed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "cv_files"


class Message(Timestamped):
    """Contact form message. Stores the minimum: no IP address, no user agent."""

    class Status(models.TextChoices):
        NEW = "new"
        READ = "read"
        ARCHIVED = "archived"
        TRASHED = "trashed"

    name = models.CharField(max_length=200)
    email = models.EmailField()
    body = models.TextField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.NEW)
    is_spam = models.BooleanField(default=False)
    notes = models.JSONField(default=list)
    trashed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "messages"
        ordering = ["-created_at"]


class Revision(Base):
    entity = models.CharField(max_length=40)
    entity_id = models.UUIDField()
    version = models.PositiveIntegerField()
    data = models.JSONField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "revisions"
        constraints = [
            models.UniqueConstraint(
                fields=["entity", "entity_id", "version"], name="revisions_unique"
            )
        ]


class AuditLog(Base):
    """Append-only. Write through core.audit.record, never directly."""

    seq = models.PositiveBigIntegerField(unique=True)
    created_at = models.DateTimeField()
    event = models.CharField(max_length=60)
    actor = models.CharField(max_length=40)
    detail = models.JSONField(default=dict)
    prev_hash = models.CharField(max_length=64, unique=True)
    hash = models.CharField(max_length=64, unique=True)

    class Meta:
        db_table = "audit_log"
        ordering = ["seq"]


class Owner(Base):
    """The one admin account. The migration creates the only row; the database
    refuses a second one and the app role cannot insert or delete it."""

    singleton = models.BooleanField(default=True, unique=True, editable=False)
    created_at = models.DateTimeField(default=timezone.now)
    bootstrapped_at = models.DateTimeField(null=True, blank=True)
    recovery_key_hash = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        db_table = "admin_owner"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(singleton=True), name="admin_owner_single_row"
            )
        ]


class AdminCredential(Base):
    """A passkey. Public key only; there is no password anywhere."""

    credential_id = models.BinaryField(max_length=1023, unique=True)
    public_key = models.BinaryField()
    sign_count = models.PositiveBigIntegerField(default=0)
    name = models.CharField(max_length=100)
    created_at = models.DateTimeField(default=timezone.now)
    last_used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "admin_credentials"


class Session(Base):
    """Only the SHA-256 of the session token is stored."""

    owner = models.ForeignKey(Owner, on_delete=models.PROTECT, related_name="+")
    token_hash = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(default=timezone.now)
    authenticated_at = models.DateTimeField(default=timezone.now)
    last_seen_at = models.DateTimeField(default=timezone.now)
    elevated_until = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "sessions"


class RateLimitBlock(Base):
    """A cool-down. The key is a keyed hash, never a raw IP address."""

    key_hash = models.CharField(max_length=64, unique=True)
    scope = models.CharField(max_length=40)
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        db_table = "rate_limit_blocks"


class PendingAction(Base):
    """A vital action waiting out its delay before it may be executed."""

    class Status(models.TextChoices):
        PENDING = "pending"
        EXECUTED = "executed"
        CANCELLED = "cancelled"
        EXPIRED = "expired"

    kind = models.CharField(max_length=40)
    payload = models.JSONField(default=dict)
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING
    )
    requested_at = models.DateTimeField(default=timezone.now)
    execute_after = models.DateTimeField()
    expires_at = models.DateTimeField()
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "pending_actions"
        ordering = ["requested_at"]
