"""Публичный Helm chart и состав runtime-образа."""

import shutil
import subprocess
import unittest
from pathlib import Path

import yaml


class DeploymentTests(unittest.TestCase):
    def render(self, *extra):
        helm = shutil.which("helm") or str(Path("output/ci-tools/helm").resolve())
        return subprocess.run(
            [
                helm,
                "template",
                "notemora",
                "deploy/chart",
                "--namespace",
                "notemora",
                "--set-string",
                "image.tag=test-commit",
                "--set-string",
                "image.digest=sha256:" + "a" * 64,
                *extra,
            ],
            text=True,
            capture_output=True,
        )

    def test_persistent_private_nonroot_deployment(self):
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        resources = list(yaml.safe_load_all(result.stdout))
        app = next(r for r in resources if r["kind"] == "Deployment")
        spec = app["spec"]["template"]["spec"]
        self.assertFalse(spec["automountServiceAccountToken"])
        self.assertEqual(spec["securityContext"]["runAsUser"], 10001)
        self.assertTrue(spec["containers"][0]["securityContext"]["readOnlyRootFilesystem"])
        self.assertIn("@sha256:", spec["containers"][0]["image"])
        self.assertEqual(app["spec"]["replicas"], 1)
        self.assertTrue(any(r["kind"] == "PersistentVolumeClaim" for r in resources))
        database = next(r for r in resources if r["kind"] == "StatefulSet")
        self.assertTrue(database["spec"]["volumeClaimTemplates"])
        job = next(r for r in resources if r["kind"] == "Job")
        self.assertEqual(
            job["spec"]["template"]["spec"]["containers"][0]["command"], ["review-admin", "migrate"]
        )
        self.assertNotIn("POSTGRES_PASSWORD: review", result.stdout)

    def test_operator_can_choose_domain_registry_and_secret(self):
        result = self.render(
            "--set-string",
            "host=notes.example.net",
            "--set-string",
            "image.repository=ghcr.io/example/notemora",
            "--set-string",
            "runtimeSecret=my-runtime",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("https://notes.example.net", result.stdout)
        self.assertIn("ghcr.io/example/notemora@sha256:", result.stdout)
        self.assertIn("name: my-runtime", result.stdout)

    def test_invalid_domain_floating_images_and_missing_digest_are_rejected(self):
        for value in ["host=bad host", "image.tag=latest", "image.digest=", "runtimeSecret="]:
            with self.subTest(value=value):
                self.assertNotEqual(self.render("--set-string", value).returncode, 0)

    def test_pull_credentials_are_optional_and_only_applied_when_requested(self):
        for secret in ["", "my-pull-secret"]:
            result = self.render("--set-string", f"pullSecret={secret}")
            self.assertEqual(result.returncode, 0, result.stderr)
            resources = list(yaml.safe_load_all(result.stdout))
            for resource in resources:
                if resource["kind"] not in ["Deployment", "Job"]:
                    continue
                spec = resource["spec"]["template"]["spec"]
                if secret:
                    self.assertEqual(spec["imagePullSecrets"], [{"name": secret}])
                else:
                    self.assertNotIn("imagePullSecrets", spec)

    def test_runtime_does_not_copy_developer_data_and_includes_license(self):
        dockerfile = Path("Dockerfile").read_text()
        runtime = dockerfile[dockerfile.rindex("FROM ") :]
        for value in ["COPY . ", "apps/demo", ".env", "tests/", "node_modules", "uv sync"]:
            self.assertNotIn(value, runtime)
        self.assertTrue(Path(".dockerignore").read_text().startswith("**\n"))
        self.assertIn("COPY LICENSE", runtime)


if __name__ == "__main__":
    unittest.main()
