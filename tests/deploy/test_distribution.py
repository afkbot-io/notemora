"""Публичная поставка собирается без приватного registry и production-доступов."""

import json
import unittest
from pathlib import Path

import yaml


class DistributionTests(unittest.TestCase):
    def test_sdk_is_a_self_contained_unpublished_workspace(self):
        manifest = json.loads(Path("packages/sdk/package.json").read_text())
        self.assertEqual(manifest["name"], "@notemora/sdk")
        self.assertEqual(manifest["version"], "0.1.0")
        self.assertTrue(manifest["private"])
        self.assertNotIn("publishConfig", manifest)
        self.assertEqual(manifest["files"], ["dist"])

    def test_compose_has_its_own_names_and_loopback_ports(self):
        config = yaml.safe_load(Path("compose.yaml").read_text())
        self.assertEqual(config["name"], "notemora")
        self.assertEqual(config["services"]["api"]["image"], "notemora:local")
        self.assertIn("127.0.0.1:5292:8990", config["services"]["api"]["ports"])
        self.assertIn("127.0.0.1:55582:5432", config["services"]["db"]["ports"])

    def test_ci_checks_code_without_publishing_or_using_repository_secrets(self):
        workflow = yaml.safe_load(Path(".github/workflows/ci.yml").read_text())
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        self.assertTrue({"api", "web", "deployment", "container"} <= workflow["jobs"].keys())
        for job in workflow["jobs"].values():
            self.assertNotIn("environment", job)
        content = Path(".github/workflows/ci.yml").read_text()
        self.assertNotIn("secrets.", content)
        self.assertNotIn("docker push", content)
        self.assertNotIn("npm publish", content)
        self.assertIn("persist-credentials: false", content)


if __name__ == "__main__":
    unittest.main()
