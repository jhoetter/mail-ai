import type { ComponentType } from "react";

export type MailInitialRoute = "/inbox" | "/calendar" | "/settings/account";
export interface MailRuntimeConfig {
  apiBase?: string;
  wsBase?: string;
  workspaceId?: string;
  identity?: { id: string; name?: string; email?: string };
  getAuthToken?: () => Promise<string>;
}
export interface MailAiHostProps {
  runtime: MailRuntimeConfig;
  initialRoute?: MailInitialRoute;
}
export interface MailAiRouteDefinition {
  path: string;
  initialRoute: MailInitialRoute;
}
export declare const product: "mailai";
export declare const routes: MailAiRouteDefinition[];
export declare const mailAiRoutes: MailAiRouteDefinition[];
export declare const MailAiHost: ComponentType<MailAiHostProps>;
export { MailAiHost as Host };
