# Manual one-time steps

Everything else in this repo's Docker packaging is scripted
(`deploy/install.sh`, the `Makefile`). These two steps need a human with
access to the DNS provider's control panel and to this box's certificate
state, and are not something a script run from this checkout can do safely.

## 1. DNS: add the `area` hostname

At the DNS provider (one.com), add:

```
area   CNAME   nesthus.dedyn.io.
```

**Use a CNAME, not an A record.** One.com's panel defaults new records to
A, which is the wrong choice here: an A record would point the name at a
fixed IP that goes stale the moment the dynamic address changes, breaks
certificate issuance (the ACME challenge resolves the name itself, not
whatever it points to), and can misroute traffic to the wrong host
entirely if that IP is later reassigned. The CNAME always resolves to
wherever the dynamic DNS record currently points, which is what every
other hostname on this box already does.

## 2. Certificate: expand the existing shared certificate

This box serves multiple hostnames off one certificate. Check the
_current_ list of names before running anything below -- it will have
changed by the time this file is read again:

```
sudo certbot certificates
```

Then expand the certificate to include `area.nesthus.no`, substituting the
`-d` list above (all existing names, plus the new one) for
`<existing-name-1> <existing-name-2> ...`:

```
sudo certbot certonly --webroot -w /var/www/html \
  --cert-name projects \
  --expand \
  -d <existing-name-1> -d <existing-name-2> -d area.nesthus.no \
  --deploy-hook "systemctl reload apache2"
```

Adjust `--webroot -w` to whatever webroot path the existing certificate
actually uses (visible in the `certbot certificates` output above) if it
differs from this example.

## 3. Verify

Check DNS from a public resolver first, then from this box:

```
dig +short area.nesthus.no @1.1.1.1
dig +short area.nesthus.no
```

If the public resolver already has the right answer but the local one
doesn't, that's a stale answer cached one hop beyond anything this box
controls -- it is not a sign of a broken deploy, and a router reboot does
not reliably clear it. Give it time, or point the router's own upstream
DNS at a public resolver, before assuming DNS or the deploy is broken.

Once DNS resolves everywhere, confirm the site itself:

```
curl -fsS https://area.nesthus.no/healthz
```

A `200` with `{"ok":true,...}` in the body means the hostname, the
certificate, and the app are all correctly wired together.
