import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth";
import { type AuthCapabilities, fetchAuthCapabilities } from "../lib/auth-capabilities";
import { runSsoFlow } from "../lib/sso-flow";
import { WindowChrome } from "./WindowChrome";

export function WelcomePage() {
  const navigate = useNavigate();
  // AgentLoom: a deployment whose only way in is its SSO (agentloom.corp: authentik) shows
  // one button that starts it, instead of Sign up and Sign in pages that both lead there.
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
  const [ssoFailed, setSsoFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void fetchAuthCapabilities()
      .then((next) => {
        if (active) setCapabilities(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const ssoOnly = capabilities?.sso && !capabilities.passwordAuth ? capabilities.sso : null;

  async function continueWithSso() {
    setSsoFailed(false);
    try {
      const result = await runSsoFlow(
        (disableRedirect, callbackURL) =>
          authClient.signIn.social({
            disableRedirect,
            provider: "oidc",
            newUserCallbackURL: callbackURL("/onboarding"),
            callbackURL: callbackURL("/app"),
            errorCallbackURL: callbackURL("/sign-in"),
          }),
        ["/app", "/onboarding", "/sign-in"],
      );
      if (result.error) setSsoFailed(true);
    } catch {
      setSsoFailed(true);
    }
  }

  return (
    <div className="flex min-h-full flex-col bg-background" data-rakazo-surface="welcome">
      <div className="app-drag flex gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center gap-11 px-5 pb-[90px]">
        <div className="flex items-center gap-[18px] sm:gap-[26px]">
          <div className="flex size-16 items-center justify-center gap-[9px] rounded-full bg-accent sm:size-[88px] sm:gap-[13px]">
            <span className="h-[17px] w-2 rounded-full bg-card sm:h-6 sm:w-[11px]" />
            <span className="h-[17px] w-2 rounded-full bg-card sm:h-6 sm:w-[11px]" />
          </div>
          <h1 className="text-[56px] leading-none tracking-[-0.03em] text-foreground sm:text-[76px]">
            Rakazo
          </h1>
        </div>
        <p className="max-w-[600px] text-center text-[27px] leading-[1.4] text-foreground/75">
          <Trans>
            Your team of always-on agents
            <br />
            that you can give real work to.
          </Trans>
        </p>
        {ssoOnly ? (
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              data-testid="welcome-sso"
              onClick={() => void continueWithSso()}
              className="app-no-drag rounded-full bg-accent px-[34px] py-[15px] text-[19px] text-foreground transition hover:scale-[1.04] hover:bg-accent"
            >
              <Trans>Continue with {ssoOnly.name}</Trans>
              <span aria-hidden="true">&nbsp;&nbsp;→</span>
            </button>
            {ssoFailed ? (
              <p role="alert" className="text-sm text-destructive">
                <Trans>Could not continue</Trans>
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => navigate("/sign-up")}
              className="app-no-drag rounded-full bg-accent px-[34px] py-[15px] text-[19px] text-foreground transition hover:scale-[1.04] hover:bg-accent"
            >
              <Trans>Sign up</Trans>
              <span aria-hidden="true">&nbsp;&nbsp;→</span>
            </button>
            <Link
              to="/sign-in"
              className="app-no-drag rounded-full px-[34px] py-[15px] text-[19px] text-foreground/75 transition hover:text-foreground"
            >
              <Trans>Sign in</Trans>
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
