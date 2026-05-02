import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { rootRoute } from "./_root";
import { InviteAcceptPage } from "@/pages/InviteAcceptPage";

function InviteAcceptRoute() {
  const { token } = useParams({ from: "/invite/$token" });
  const nav = useNavigate();
  return (
    <InviteAcceptPage
      token={token}
      onAccepted={(result) =>
        nav({
          to: "/projects/$projectId",
          params: { projectId: result.project_id },
        })
      }
    />
  );
}

export const inviteAcceptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: InviteAcceptRoute,
});
