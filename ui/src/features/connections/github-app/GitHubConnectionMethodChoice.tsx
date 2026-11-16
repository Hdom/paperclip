import { useState } from "react";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { Button } from "@/components/ui/button";

/** Actor identity is chosen before method-specific enrollment or credentials. */
export function GitHubConnectionMethodChoice({ onChoose, onCancel }: { onChoose: (key: string) => void; onCancel: () => void }) {
  const [method, setMethod] = useState("managed");
  return <div className="mx-auto max-w-xl space-y-6">
    <div><h1 className="text-lg font-semibold">Connect GitHub</h1><p className="mt-2 text-sm text-muted-foreground">Choose the identity this connection will use.</p></div>
    <RadioCardGroup ariaLabel="GitHub connection method" value={method} onValueChange={setMethod} options={[
      { value: "managed", title: "GitHub account", description: "Sign in as a GitHub user through Paperclip-managed sign-in. Requires connecting this instance to Paperclip." },
      { value: "app-installation", title: "GitHub App installation", description: "Use an App’s bot identity with selected repository access. Connects directly to GitHub; no Paperclip connection is required." },
    ]} />
    <details><summary className="text-sm text-muted-foreground">Advanced</summary><RadioCardGroup className="mt-3" ariaLabel="Advanced GitHub authentication" value={method} onValueChange={setMethod} options={[
      { value: "mcp-key", title: "Personal access token", description: "Use the existing token-based connection flow." },
    ]} /></details>
    <div className="flex items-center justify-between gap-3"><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button onClick={() => onChoose(method)}>Continue</Button></div>
  </div>;
}
