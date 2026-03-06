"""Tests for the scope_matches() filter in adapters/base.py."""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure agents_view package is importable regardless of cwd.
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import pytest
from agents_view.adapters.base import scope_matches


class TestScopeMatchesExactMatch:
    def test_exact_path_matches(self):
        assert scope_matches("/home/colin/project", "/home/colin/project")

    def test_exact_path_with_trailing_slash_in_root(self):
        # scope_root with trailing slash should still match exact path
        assert scope_matches("/home/colin/project", "/home/colin/project/")

    def test_trailing_slash_both_sides(self):
        # Both have trailing slashes — normalized scope_root, raw cwd
        assert scope_matches("/home/colin/project", "/home/colin/project/")


class TestScopeMatchesDescendant:
    def test_direct_child_matches(self):
        assert scope_matches("/home/colin/project/src", "/home/colin/project")

    def test_deep_descendant_matches(self):
        assert scope_matches(
            "/home/colin/project/src/utils/helpers",
            "/home/colin/project",
        )

    def test_descendant_of_trailing_slash_root(self):
        assert scope_matches("/home/colin/project/src", "/home/colin/project/")


class TestScopeMatchesRejection:
    def test_sibling_directory_excluded(self):
        assert not scope_matches("/home/colin/other", "/home/colin/project")

    def test_prefix_collision_no_false_positive(self):
        # "/home/colin/proj" must NOT match scope_root "/home/colin/project"
        assert not scope_matches("/home/colin/proj", "/home/colin/project")

    def test_parent_directory_excluded(self):
        # Parent must not match a deeper scope_root
        assert not scope_matches("/home/colin", "/home/colin/project")

    def test_unrelated_path_excluded(self):
        assert not scope_matches("/var/log/syslog", "/home/colin/project")

    def test_empty_cwd_excluded(self):
        assert not scope_matches("", "/home/colin/project")

    def test_empty_cwd_root_scope(self):
        # empty cwd with root scope: root matches everything; empty string is
        # technically not a descendant of "/" but scope_root=="/" short-circuits.
        assert scope_matches("", "/")


class TestScopeMatchesRootScope:
    def test_root_scope_matches_any_path(self):
        assert scope_matches("/home/colin/project", "/")

    def test_root_scope_matches_root_itself(self):
        assert scope_matches("/", "/")

    def test_root_scope_matches_deep_path(self):
        assert scope_matches("/var/lib/postgresql/data", "/")


class TestScopeMatchesEdgeCases:
    def test_scope_root_equals_filesystem_root(self):
        assert scope_matches("/home", "/")

    def test_same_prefix_different_final_segment(self):
        # "/data/projectX" must not match "/data/project"
        assert not scope_matches("/data/projectX", "/data/project")

    def test_scope_root_with_multiple_trailing_slashes(self):
        # Normalize even with multiple slashes
        assert scope_matches("/home/colin/project/src", "/home/colin/project///")
