import { SignIn } from "@clerk/nextjs";

/**
 * One door, one provider.
 *
 * The Clerk instance has GitHub as its only enabled connection, with password
 * and email sign-in switched off, so this renders a single button. Clerk's
 * default skin is light; the variables below drop it into the console palette
 * rather than flashing a white card at someone checking the org at 1am.
 */
export default function SignInPage() {
	return (
		<div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
			<SignIn
				appearance={{
					variables: {
						colorBackground: "#101214",
						colorPrimary: "#5aa9d6",
						colorForeground: "#d7dbde",
						colorMutedForeground: "#868d94",
						colorInput: "#15181a",
						colorInputForeground: "#d7dbde",
						borderRadius: "0px",
						fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
					},
					elements: { card: { border: "1px solid #282c30", boxShadow: "none" } },
				}}
			/>
		</div>
	);
}
