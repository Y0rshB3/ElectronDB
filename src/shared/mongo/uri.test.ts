import { describe, expect, it } from 'vitest'
import { defaultMongoOptions } from '../engines'
import { CREDENTIALS_IN_PARAMETERS, MongoUriError, mongoUriOf, parseMongoUri } from './uri'

describe('parseMongoUri («Pegar URI»)', () => {
  it('splits a standalone URI and keeps the password apart', () => {
    const p = parseMongoUri('mongodb://ana:s%40cret@db.example:27018/shop?authSource=admin')
    expect(p).toMatchObject({
      host: 'db.example',
      port: 27018,
      username: 'ana',
      password: 's@cret'
    })
    expect(p.mongo).toMatchObject({ topology: 'standalone', defaultDatabase: 'shop', srv: false })
    expect(JSON.stringify(p.mongo)).not.toContain('s@cret')
  })

  it('reads a replica set seed list', () => {
    const p = parseMongoUri(
      'mongodb://a.example:27017,b.example:27018/?replicaSet=rs0&readPreference=secondaryPreferred'
    )
    expect(p.mongo.topology).toBe('replicaSet')
    expect(p.mongo.replicaSet).toBe('rs0')
    expect(p.mongo.members).toEqual([
      { host: 'a.example', port: 27017 },
      { host: 'b.example', port: 27018 }
    ])
    expect(p.mongo.readPreference).toBe('secondaryPreferred')
    expect(p.mongo.authMechanism).toBe('none')
  })

  it('turns TLS on for SRV and leaves the port unused', () => {
    const p = parseMongoUri('mongodb+srv://u:p@cluster0.example.net/app?retryWrites=false')
    expect(p).toMatchObject({ host: 'cluster0.example.net', port: 0 })
    expect(p.ssl.enabled).toBe(true)
    expect(p.mongo).toMatchObject({ srv: true, retryWrites: false })
  })

  it('refuses credentials in the parameters without echoing them', () => {
    for (const uri of [
      'mongodb://h/?authMechanismProperties=AWS_SESSION_TOKEN:abc',
      'mongodb://h/?tlsCertificateKeyFilePassword=topsecret',
      'mongodb://h/?proxyPassword=topsecret',
      'mongodb://h/?password=topsecret'
    ]) {
      let message = ''
      try {
        parseMongoUri(uri)
      } catch (err) {
        expect(err).toBeInstanceOf(MongoUriError)
        message = (err as Error).message
      }
      expect(message).toBe(CREDENTIALS_IN_PARAMETERS)
      expect(message).not.toContain('topsecret')
    }
  })

  it('refuses unsupported mechanisms and bad URIs', () => {
    expect(() => parseMongoUri('mongodb://h/?authMechanism=GSSAPI')).toThrow(/no soportado/)
    expect(() => parseMongoUri('mongodb://h/?authMechanism=MONGODB-AWS')).toThrow(/no soportado/)
    expect(() => parseMongoUri('postgres://h/')).toThrow(/mongodb:\/\//)
    expect(() => parseMongoUri('mongodb+srv://a,b/')).toThrow(/un solo nombre/)
    expect(() => parseMongoUri('mongodb://h:99999/')).toThrow(/puerto/)
  })

  it('keeps other options as extra options', () => {
    const p = parseMongoUri(
      'mongodb://h/?compressors=zlib&appName=x&tls=true&tlsAllowInvalidHostnames=true'
    )
    expect(p.mongo.extraOptions).toEqual({ compressors: 'zlib', appName: 'x' })
    expect(p.ssl).toMatchObject({ enabled: true, verifyServer: false })
  })
})

describe('mongoUriOf («Copiar URI»)', () => {
  it('never includes a password', () => {
    const uri = mongoUriOf({
      host: 'db.example',
      port: 27017,
      username: 'ana',
      ssl: { enabled: false, verifyServer: true },
      mongo: { ...defaultMongoOptions(), defaultDatabase: 'shop', authSource: 'users' }
    })
    expect(uri).toBe('mongodb://ana@db.example:27017/shop?authSource=users')
  })

  it('round-trips through parseMongoUri', () => {
    const mongo = {
      ...defaultMongoOptions(),
      topology: 'replicaSet' as const,
      replicaSet: 'rs0',
      members: [
        { host: 'a', port: 1 },
        { host: 'b', port: 2 }
      ],
      readPreference: 'nearest' as const,
      authMechanism: 'scram-sha-256' as const,
      retryReads: false,
      extraOptions: { compressors: 'zlib' }
    }
    const uri = mongoUriOf({
      host: 'a',
      port: 1,
      username: 'u',
      ssl: { enabled: true, verifyServer: true },
      mongo
    })
    const back = parseMongoUri(uri)
    expect(back.mongo).toMatchObject({
      topology: 'replicaSet',
      replicaSet: 'rs0',
      members: mongo.members,
      readPreference: 'nearest',
      authMechanism: 'scram-sha-256',
      retryReads: false,
      extraOptions: { compressors: 'zlib' }
    })
    expect(back.ssl.enabled).toBe(true)
    expect(back.password).toBeNull()
  })
})
