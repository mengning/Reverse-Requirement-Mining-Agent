import {hash} from './collect.mjs';
import {validateProbe} from './task.mjs';

const sameValue=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

// S-F2 signature: one probe is exactly one (argv, stdin, file_text) tuple. Every
// place that binds a saved observation to its two original executions uses this
// single function, so adding a file mode cannot leave one comparison behind.
export const probeSignature=probe=>hash([probe?.argv,probe?.stdin,probe?.file_text]);

// A result/progress checkpoint is only evidence when the saved observation is
// reproduced by two original execution records with the same invocation.
export function matchesExecutionRecord(record,result) {
  return ['stdout','stderr','exit_code','raw_bytes'].every(key=>sameValue(record?.[key],result?.[key]));
}

export function observationRecords(records,observation,executable) {
  const signature=probeSignature(observation);
  return (Array.isArray(records)?records:[]).filter(record=>record &&
    record.executable===executable && probeSignature(record)===signature).slice(-2);
}

export function validateObservationEvidence(observation,records,executable) {
  if(!observation || typeof observation.id!=='string' || !Array.isArray(observation.argv) ||
      typeof observation.stdin!=='string' || typeof observation.stdout!=='string' ||
      typeof observation.stderr!=='string' || !Number.isInteger(observation.exit_code))
    throw Error('Invalid observation evidence');
  const {sha256,...body}=observation;
  if(sha256!==hash(body)) throw Error('Observation digest mismatch');
  const matching=observationRecords(records,observation,executable);
  if(matching.length!==2 || !matchesExecutionRecord(matching[0],observation) ||
      !matchesExecutionRecord(matching[1],observation.repeat_result || observation))
    throw Error('Observation is not backed by its two original executions');
  return observation;
}

// The only fields an observation may carry. Anything else would be content the
// gate never validated, so it fails closed instead of travelling on inside the
// digest.
const OBSERVATION_FIELDS=new Set(['id','argv','stdin','file_text','stdout','stderr','exit_code',
  'raw_bytes','repeat_result','unsupported','sha256']);

// Validate every saved probe against the frozen task argument policy before a
// checkpoint can be resumed. Duplicate IDs are rejected so a later round cannot
// silently overwrite an earlier observation.
export function validateProbeEvidence(observations,task) {
  const ids=new Set();
  for(const observation of observations) {
    if(!observation || typeof observation.id!=='string' || !Array.isArray(observation.argv) ||
        typeof observation.stdin!=='string') throw Error('Invalid observation evidence');
    const unknown=Object.keys(observation).filter(key=>!OBSERVATION_FIELDS.has(key));
    if(unknown.length) throw Error(`Unknown observation field(s): ${unknown.join(', ')}; the evidence gate does not forward unvalidated content`);
    if(observation.file_text!==undefined && task.profile!=='cli-text-file/v1')
      throw Error('File fixture is not supported by this capability profile');
    if(observation.unsupported!==undefined &&
        (task.profile!=='adapter-json/v1' || observation.unsupported!==true))
      throw Error('Unsupported marker requires the JSON adapter profile');
    if(ids.has(observation.id)) throw Error('Duplicate observation IDs');
    ids.add(observation.id);
    validateProbe({id:observation.id,argv:observation.argv,stdin:observation.stdin,
      ...(observation.file_text!==undefined?{file_text:observation.file_text}:{})},task);
  }
  return observations;
}

// Public documents must match the frozen task and, for path documents, be backed
// by the recorded /bin/cat read. Inline documents are already frozen in the task.
export function validateDocumentEvidence(inputDocuments,task,records) {
  if(!Array.isArray(inputDocuments) || inputDocuments.length!==task.documents.length)
    throw Error('Public document set changed');
  if(new Set(inputDocuments.map(document=>document?.id)).size!==inputDocuments.length)
    throw Error('Duplicate public document IDs');
  for(const document of task.documents) {
    const saved=inputDocuments.find(candidate=>candidate?.id===document.id);
    if(!saved || typeof saved.text!=='string' || saved.sha256!==hash(saved.text))
      throw Error('Public document is not backed by the original task or read record');
    if(document.text!==undefined) {
      if(saved.text!==document.text)
        throw Error('Public document is not backed by the original task or read record');
    } else if(!(Array.isArray(records) && records.some(record=>record?.executable==='/bin/cat' &&
      sameValue(record.argv,[document.path]) && record.exit_code===0 && record.stdout===saved.text))) {
      throw Error('Public document is not backed by the original task or read record');
    }
  }
  return inputDocuments;
}
