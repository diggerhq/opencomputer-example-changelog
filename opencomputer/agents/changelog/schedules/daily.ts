import { defineSchedule } from "@opencomputer/agent";

export default defineSchedule({
  id: "daily-changelog",
  cron: "0 9 * * *",
  timezone: "America/Los_Angeles",
  enabled: ["production"],
  overlap: "skip",
  dispatch: {
    text: "Review the configured repository's last 48 hours and open a changelog pull request when there are user-visible changes.",
    payload: {
      workflow: "update_changelog",
      lookbackHours: 48,
    },
  },
});
