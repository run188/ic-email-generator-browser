import tempfile
import unittest
from pathlib import Path
import server


class TaskStepTests(unittest.TestCase):
    def test_applies_structured_step_event(self):
        task = {"steps": [], "message": ""}
        server.apply_step_event(
            task,
            {
                "stepId": "prepare_hide_my_email",
                "title": "打开并检查隐藏邮箱",
                "status": "retry",
                "message": "第 2/5 次检查",
                "attempt": 2,
                "total": 5,
            },
        )
        self.assertEqual(task["currentStep"]["status"], "retry")
        self.assertEqual(task["currentStep"]["attempt"], 2)
        self.assertEqual(len(task["steps"]), 1)

    def test_manual_verification_timeout_message(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            log_path = Path(temp_dir) / "task.log"
            log_path.write_text(
                "RuntimeError: timed out waiting for manual verification\n",
                encoding="utf-8",
            )
            message = server.task_failure_message(log_path)
        self.assertIn("手动验证码", message)

    def test_step_event_does_not_unpause_task(self):
        task = {"steps": [], "message": "", "status": "paused", "paused": True}
        server.apply_step_event(
            task,
            {
                "stepId": "create_emails",
                "title": "创建隐私邮箱",
                "status": "running",
                "message": "已创建 1/5 个",
            },
        )
        self.assertEqual(task["status"], "paused")
        self.assertTrue(task["paused"])

    def test_manual_code_step_sets_waiting_status(self):
        task = {"steps": [], "message": "", "status": "running"}
        server.apply_step_event(
            task,
            {
                "stepId": "wait_manual_code",
                "title": "等待手动验证码",
                "status": "waiting_for_user",
            },
        )
        self.assertEqual(task["status"], "waiting_for_manual_code")


if __name__ == "__main__":
    unittest.main()
