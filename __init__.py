"""Connections backend plugin package."""


def register(ctx):
    """The plugin exposes only a dashboard API; no model tools are added."""
    del ctx
