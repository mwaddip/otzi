import { useState, useCallback } from 'react';
import { OP20_METHODS, type MethodDef, type MethodParam } from '../lib/op20-methods';
import { encodeTx } from '../lib/api';
import type { ContractConfig } from '../lib/vault-types';

type InputMode = 'op20' | 'abi' | 'raw';

interface Props {
  contracts: ContractConfig[];
  onMessageBuilt: (message: Uint8Array, meta: MessageMeta) => void;
}

export interface MessageMeta {
  contractAddress: string;
  method: string;
  params: Record<string, string>;
  messageHash: string;
}

export function MessageBuilder({ contracts, onMessageBuilt }: Props) {
  const hasConfiguredContracts = contracts.length > 0;

  // If contracts are configured, use config mode exclusively
  const [mode, setMode] = useState<InputMode>(hasConfiguredContracts ? 'op20' : 'op20');
  const [contractAddr, setContractAddr] = useState(hasConfiguredContracts ? contracts[0]!.address : '');
  const [selectedMethod, setSelectedMethod] = useState('');
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [rawHex, setRawHex] = useState('');
  const [abiText, setAbiText] = useState('');
  const [abiMethods, setAbiMethods] = useState<MethodDef[]>([]);
  const [error, setError] = useState('');

  // Determine available methods
  const getAvailableMethods = (): MethodDef[] => {
    if (hasConfiguredContracts) {
      const contract = contracts.find(c => c.address === contractAddr);
      if (!contract) return [];
      // Filter OP20_METHODS to only configured ones, or use ABI methods
      if (contract.abi && contract.abi.length > 0) {
        return parseAbiMethods(contract.abi).filter(m => contract.methods.includes(m.name));
      }
      return OP20_METHODS.filter(m => contract.methods.includes(m.name));
    }
    if (mode === 'abi') return abiMethods;
    return OP20_METHODS;
  };

  const methods = getAvailableMethods();
  const currentMethod = methods.find(m => m.name === selectedMethod);

  const handleParamChange = (name: string, value: string) => {
    setParamValues(prev => ({ ...prev, [name]: value }));
  };

  const handleParseAbi = () => {
    try {
      const abi = JSON.parse(abiText);
      const parsed = parseAbiMethods(abi);
      setAbiMethods(parsed);
      setError('');
    } catch {
      setError('Invalid ABI JSON');
    }
  };

  const handleBuild = useCallback(async () => {
    setError('');
    try {
      let message: Uint8Array;

      let messageHash: string;

      if (mode === 'raw') {
        const hex = rawHex.replace(/^0x/, '');
        message = new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
        const hashBuf = await crypto.subtle.digest('SHA-256', message);
        messageHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        if (!contractAddr || !selectedMethod) {
          setError('Select a contract and method');
          return;
        }
        // Use backend to encode calldata with BinaryWriter (proper OPNet encoding)
        const paramNames = currentMethod?.params.map(p => p.name) || [];
        const paramVals = paramNames.map(n => paramValues[n] || '');
        const paramTypes = (currentMethod?.params || []).map(p => p.type);

        const encoded = await encodeTx(selectedMethod, paramVals, paramTypes);
        const hex = encoded.calldata;
        message = new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
        messageHash = encoded.messageHash;
      }

      onMessageBuilt(message, {
        contractAddress: contractAddr,
        method: selectedMethod || 'raw',
        params: paramValues,
        messageHash,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [mode, contractAddr, selectedMethod, paramValues, rawHex, currentMethod, onMessageBuilt]);

  return (
    <div className="card">
      <h2>Build Message</h2>

      {/* Contract selector */}
      {hasConfiguredContracts ? (
        <div className="form-row">
          <label>
            Contract
            <select value={contractAddr} onChange={e => { setContractAddr(e.target.value); setSelectedMethod(''); }}>
              {contracts.map(c => (
                <option key={c.address} value={c.address}>{c.name || c.address}</option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <>
          {/* Mode selector */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {(['op20', 'abi', 'raw'] as const).map(m => (
              <button
                key={m}
                className={`btn ${mode === m ? 'btn-primary' : 'btn-secondary'}`}
                style={{ flex: 1, padding: '8px 12px', fontSize: 13 }}
                onClick={() => { setMode(m); setSelectedMethod(''); setError(''); }}
              >
                {m === 'op20' ? 'OP-20' : m === 'abi' ? 'Custom ABI' : 'Raw Hex'}
              </button>
            ))}
          </div>

          {/* Contract address input (op20 and abi modes) */}
          {mode !== 'raw' && (
            <div className="form-row">
              <label>
                Contract Address
                <input
                  value={contractAddr}
                  onChange={e => setContractAddr(e.target.value)}
                  placeholder="0x..."
                />
              </label>
            </div>
          )}
        </>
      )}

      {/* ABI paste area */}
      {mode === 'abi' && !hasConfiguredContracts && (
        <div style={{ marginBottom: 16 }}>
          <textarea
            className="blob-textarea"
            value={abiText}
            onChange={e => setAbiText(e.target.value)}
            placeholder="Paste ABI JSON here..."
            rows={4}
          />
          <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={handleParseAbi}>
            Parse ABI
          </button>
        </div>
      )}

      {/* Method selector */}
      {mode !== 'raw' && methods.length > 0 && (
        <div className="form-row">
          <label>
            Method
            <select value={selectedMethod} onChange={e => { setSelectedMethod(e.target.value); setParamValues({}); }}>
              <option value="">Select method...</option>
              {methods.map(m => (
                <option key={m.name} value={m.name}>{m.label || m.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Dynamic params */}
      {currentMethod && currentMethod.params.map(p => (
        <div className="form-row" key={p.name}>
          <label>
            {p.name} <span style={{ color: 'var(--gray)', fontWeight: 400 }}>({p.type})</span>
            <input
              value={paramValues[p.name] || ''}
              onChange={e => handleParamChange(p.name, e.target.value)}
              placeholder={p.placeholder || p.name}
            />
          </label>
        </div>
      ))}

      {/* Raw hex input */}
      {mode === 'raw' && (
        <div className="form-row">
          <label>
            Message (hex)
            <textarea
              className="blob-textarea"
              value={rawHex}
              onChange={e => setRawHex(e.target.value)}
              placeholder="0x..."
              rows={3}
            />
          </label>
        </div>
      )}

      {error && <div className="warning">{error}</div>}

      <button className="btn btn-primary btn-full" onClick={handleBuild}>
        Build Message
      </button>
    </div>
  );
}

// ── Helpers ──

function parseAbiMethods(abi: unknown[]): MethodDef[] {
  return (abi as Array<{ name?: string; inputs?: Array<{ name: string; type: string }> }>)
    .filter(entry => entry.name && entry.inputs)
    .map(entry => ({
      name: entry.name!,
      label: entry.name!,
      params: (entry.inputs || []).map(inp => ({
        name: inp.name,
        type: mapAbiType(inp.type),
        placeholder: `${inp.name} (${inp.type})`,
      })),
    }));
}

function mapAbiType(abiType: string): 'address' | 'u256' | 'bytes' {
  if (abiType.includes('address') || abiType.includes('Address')) return 'address';
  if (abiType.includes('uint') || abiType.includes('int') || abiType.includes('u256')) return 'u256';
  return 'bytes';
}
