# Armin Mehri — mehri.armin@gmail.com
"""Collect images from the web for a task, by keywords.

A task keeps a list of keywords, each with how many images it should
hold. A run searches the free sources (Bing, Wikimedia Commons,
Openverse) for every keyword that is short, downloads what it finds,
throws away what is small, duplicated, AI-made, watermarked or from a
blocked site, and adds the rest to the task as ordinary assets.

Runs are rows (``web_collect_jobs``) worked by the ``collect`` worker,
and resume from what they last committed. The sources are paced across
every run at once, so a busy day backs off instead of getting blocked.
"""
