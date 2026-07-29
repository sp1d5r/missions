import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "missions",
	description: "The org, from anywhere.",
};

/**
 * The whole point of this surface is the phone, so pin the viewport to it.
 *
 * `interactive-widget=resizes-content` is the one that makes typing feel right:
 * without it the on-screen keyboard overlays the page, so a composer pinned to
 * the bottom ends up underneath the keyboard and the line you are typing is
 * hidden. With it the viewport actually shrinks, `100dvh` means what you think,
 * and the composer sits on top of the keyboard where you can see it.
 */
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	themeColor: "#0b0c0d",
	interactiveWidget: "resizes-content",
};

// No web fonts: the console is monospace by design, and a device's own mono
// face renders instantly over a tunnel on a phone connection.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en">
			<body>
				<ClerkProvider>{children}</ClerkProvider>
			</body>
		</html>
	);
}
