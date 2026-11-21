import { SettingType, type OptionDeclaration } from '@pragmatic-tech-ai/pragmatic-component'

/** The options the env server and the gateway read through the same `ServerConfigLoader` code (one declaration for both). */
export class ServerOptionDeclarations
{
    public static readonly Tls: OptionDeclaration = {
        name: 'tls',
        description: 'Mutual TLS between the gateway and the workers (the server side).',
        settings: [
            { name: 'certificateFile', type: SettingType.String, source: 'PRAGMATIC_TLS_CERT_FILE', required: true, description: 'Path of the PEM certificate this process presents.' },
            { name: 'privateKey', type: SettingType.String, source: 'PRAGMATIC_TLS_KEY_FILE', required: true, secret: true, description: 'The PEM private key of that certificate (a mounted secret file).' },
            { name: 'caFile', type: SettingType.String, source: 'PRAGMATIC_TLS_CA_FILE', required: true, description: 'Path of the PEM CA bundle peers are verified against.' },
        ],
    }

    public static readonly ClientTls: OptionDeclaration = {
        name: 'clientTls',
        description: 'The client certificate this process presents when it connects to another cluster member.',
        settings: [
            { name: 'certificateFile', type: SettingType.String, source: 'PRAGMATIC_CLIENT_TLS_CERT_FILE', required: true, description: 'Path of the PEM client certificate.' },
            { name: 'privateKey', type: SettingType.String, source: 'PRAGMATIC_CLIENT_TLS_KEY_FILE', required: true, secret: true, description: 'The PEM private key of the client certificate (a mounted secret file).' },
            { name: 'caFile', type: SettingType.String, source: 'PRAGMATIC_CLIENT_TLS_CA_FILE', required: true, description: 'Path of the PEM CA bundle the server is verified against.' },
        ],
    }

    public static readonly Observability: OptionDeclaration = {
        name: 'observability',
        description: 'Metrics and traces.',
        settings: [
            { name: 'serviceName', type: SettingType.String, source: 'PRAGMATIC_SERVICE_NAME', description: 'The service name reported with metrics and traces.' },
            { name: 'metricsPort', type: SettingType.Integer, source: 'PRAGMATIC_METRICS_PORT', description: 'Port of the Prometheus metrics listener (off when unset).' },
            { name: 'otlpEndpoint', type: SettingType.Url, source: 'PRAGMATIC_OTLP_ENDPOINT', description: 'OTLP collector endpoint (no export when unset).' },
            { name: 'otlpProtocol', type: SettingType.String, source: 'PRAGMATIC_OTLP_PROTOCOL', default: 'http-protobuf', description: 'OTLP protocol: http-protobuf or grpc.' },
            { name: 'otlpMetrics', type: SettingType.Boolean, source: 'PRAGMATIC_OTLP_METRICS', description: 'Whether metrics are also exported over OTLP.' },
            { name: 'traceSampling', type: SettingType.String, source: 'PRAGMATIC_TRACE_SAMPLING', description: 'Trace sampling ratio between 0 and 1.' },
        ],
    }

    public static readonly WebSocket: OptionDeclaration = {
        name: 'webSocket',
        description: 'WebSocket heartbeat, idle and back-pressure limits.',
        settings: [
            { name: 'heartbeatMs', type: SettingType.Integer, source: 'PRAGMATIC_WS_HEARTBEAT_MS', default: 30000, description: 'Heartbeat interval in milliseconds.' },
            { name: 'readIdleMs', type: SettingType.Integer, source: 'PRAGMATIC_WS_READ_IDLE_MS', default: 60000, description: 'A connection silent for this many milliseconds is closed.' },
            { name: 'backpressureSoftBytes', type: SettingType.Integer, source: 'PRAGMATIC_WS_BP_SOFT_BYTES', default: 1048576, description: 'Buffered bytes at which a slow connection is paused.' },
            { name: 'backpressureHardBytes', type: SettingType.Integer, source: 'PRAGMATIC_WS_BP_HARD_BYTES', default: 8388608, description: 'Buffered bytes at which a slow connection is closed.' },
            { name: 'backpressureGraceMs', type: SettingType.Integer, source: 'PRAGMATIC_WS_BP_GRACE_MS', default: 5000, description: 'How long a connection may stay over the soft limit, in milliseconds.' },
            { name: 'maxInboundBytes', type: SettingType.Integer, source: 'PRAGMATIC_WS_MAX_INBOUND_BYTES', default: 16777216, description: 'Largest inbound message in bytes.' },
        ],
    }

    public static readonly RateLimit: OptionDeclaration = {
        name: 'rateLimit',
        description: 'Request rate limits, each an Rps + Burst pair.',
        settings: [
            { name: 'environmentRps', type: SettingType.String, source: 'PRAGMATIC_RATELIMIT_ENVIRONMENT_RPS', description: 'Requests per second per environment (a number greater than 0).' },
            { name: 'environmentBurst', type: SettingType.Integer, source: 'PRAGMATIC_RATELIMIT_ENVIRONMENT_BURST', description: 'Burst per environment (at least 1).' },
            { name: 'principalRps', type: SettingType.String, source: 'PRAGMATIC_RATELIMIT_PRINCIPAL_RPS', description: 'Requests per second per principal (a number greater than 0).' },
            { name: 'principalBurst', type: SettingType.Integer, source: 'PRAGMATIC_RATELIMIT_PRINCIPAL_BURST', description: 'Burst per principal (at least 1).' },
        ],
    }
}
