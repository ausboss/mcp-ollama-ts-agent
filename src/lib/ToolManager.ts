// lib/ToolManager.ts

import {
  CallToolResult,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types";

import { Client } from "@modelcontextprotocol/sdk/client/index";
import { convertToOpenaiTools } from "../utils/toolFormatters";
import { createMcpClients } from "../utils/mcpClient";
import { fetchTools } from "../utils/toolUtils";
import { formatToolResponse } from "../utils/toolFormatters";

// Define interface for client structure
interface McpClientEntry {
  client: Client;
  transport: any; // Type could be made more specific based on transport type
}

interface ToolParameterInfo {
  type: string;
  description?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    properties: Record<string, ToolParameterInfo>;
    required: string[];
  };
}

export class ToolManager {
  private toolMap: Map<string, Client> = new Map();
  protected clients: Map<string, McpClientEntry> = new Map();
  public tools: any[] = [];

  // Add getter method for clients
  getClients(): Map<string, McpClientEntry> {
    return this.clients;
  }

  async initialize() {
    const newClients = await createMcpClients();
    if (!newClients || newClients.size === 0) {
      throw new Error("No MCP clients loaded.");
    }

    this.clients = newClients;
    let allMcpTools: any[] = [];

    // Fetch tools from all clients
    for (const [serverName, { client }] of this.clients.entries()) {
      const mcpTools = await fetchTools(client);
      if (mcpTools) {
        allMcpTools = allMcpTools.concat(mcpTools);
        mcpTools.forEach((tool) => {
          this.toolMap.set(tool.name, client);
        });
      }
    }

    // Convert to OpenAI format for Ollama
    this.tools = convertToOpenaiTools(allMcpTools);
    return this.tools;
  }

  private async callToolWithTimeout(
    client: Client,
    name: string,
    args: any,
    timeoutMs = 30000
  ): Promise<unknown> {
    // Parse arguments if they're a string
    let parsedArgs = args;
    if (typeof args === "string") {
      try {
        parsedArgs = JSON.parse(args);
      } catch (e) {
        // If parsing fails, wrap the string in an object
        parsedArgs = { value: args };
      }
    }

    // Ensure args is an object
    if (typeof parsedArgs !== "object" || parsedArgs === null) {
      parsedArgs = {};
    }

    const toolCallPromise = client.request(
      {
        method: "tools/call",
        params: {
          name,
          arguments: parsedArgs,
        },
      },
      CallToolResultSchema
    );

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`Tool call timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    try {
      const result = await Promise.race([toolCallPromise, timeoutPromise]);
      return result;
    } catch (error) {
      throw new Error(
        `Tool call failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async handleToolCall(toolCall: any): Promise<string> {
    let toolName = "unknown_tool";
    let rawArguments: any = {};

    try {
      if (
        (typeof toolCall === "object" &&
          toolCall !== null &&
          "function" in toolCall) ||
        (toolCall?.function?.name && toolCall?.function?.arguments)
      ) {
        if (toolCall.function?.name) {
          toolName = toolCall.function.name;
          rawArguments = toolCall.function.arguments;
        } else {
          toolName = toolCall["function"]["name"];
          rawArguments = toolCall["function"]["arguments"];
        }
      } else {
        console.warn("Invalid tool call format provided.");
        return "";
      }

      let toolArgs: any = rawArguments;
      if (typeof rawArguments === "string") {
        try {
          toolArgs = JSON.parse(rawArguments);
        } catch (error: any) {
          console.debug(
            `Error parsing arguments string: ${error.message}`,
            rawArguments
          );
          throw error;
        }
      }

      const client = this.toolMap.get(toolName);
      if (!client) {
        throw new Error(`Tool '${toolName}' not found`);
      }

      const toolResponse = await this.callToolWithTimeout(
        client,
        toolName,
        toolArgs
      );
      return formatToolResponse((toolResponse as any)?.content || []);
    } catch (error: any) {
      if (error.name === "SyntaxError") {
        console.debug(
          `Error decoding arguments for tool '${toolName}': ${rawArguments}`
        );
      } else {
        console.debug(
          `Error handling tool call '${toolName}': ${error.message}`
        );
      }
      throw error;
    }
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult | undefined> {
    const clientForTool = this.toolMap.get(toolName);
    if (!clientForTool) {
      console.warn(`Tool '${toolName}' not found among available tools.`);
      return undefined;
    }

    try {
      const toolCall = {
        name: toolName,
        arguments: args,
      };

      return (await clientForTool.callTool(toolCall)) as CallToolResult;
    } catch (error) {
      console.error(`Error calling tool '${toolName}':`, error);
      return undefined;
    }
  }

  getToolParameterInfo(toolName: string): ToolDefinition | undefined {
    return this.tools.find((t) => t.name === toolName);
  }

  suggestParameterMapping(
    toolName: string,
    providedArgs: Record<string, unknown>
  ): Record<string, string> {
    const tool = this.getToolParameterInfo(toolName);
    if (!tool) return {};

    const mapping: Record<string, string> = {};
    const expectedParams = Object.keys(tool.parameters.properties);

    for (const providedParam of Object.keys(providedArgs)) {
      if (expectedParams.includes(providedParam)) {
        continue; // Parameter is already correct
      }

      const mostSimilar = this.findMostSimilarParameter(
        providedParam,
        expectedParams
      );
      if (mostSimilar) {
        mapping[providedParam] = mostSimilar;
      }
    }

    return mapping;
  }

  private findMostSimilarParameter(
    provided: string,
    expected: string[]
  ): string | null {
    const normalized = provided.toLowerCase().replace(/[_-]/g, "");
    for (const param of expected) {
      const normalizedExpected = param.toLowerCase().replace(/[_-]/g, "");
      if (
        normalizedExpected.includes(normalized) ||
        normalized.includes(normalizedExpected)
      ) {
        return param;
      }
    }
    return null;
  }

  async cleanup() {
    if (this.clients) {
      for (const { client, transport } of this.clients.values()) {
        await client.close();
        await transport.close();
      }
    }
  }
}