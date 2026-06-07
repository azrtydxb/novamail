{{- define "novamail.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "novamail.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "novamail.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "novamail.labels" -}}
app.kubernetes.io/name: {{ include "novamail.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "novamail.ingress.selectorLabels" -}}
app.kubernetes.io/name: {{ include "novamail.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: ingress
{{- end -}}

{{- define "novamail.ingressImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s/ingress:%s" .Values.image.registry $tag -}}
{{- end -}}

{{- define "novamail.deliveryImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s/delivery:%s" .Values.image.registry $tag -}}
{{- end -}}

{{- define "novamail.maintenanceImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s/maintenance:%s" .Values.image.registry $tag -}}
{{- end -}}

{{- define "novamail.delivery.selectorLabels" -}}
app.kubernetes.io/name: {{ include "novamail.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: delivery
{{- end -}}

{{- define "novamail.dsnImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s/dsn:%s" .Values.image.registry $tag -}}
{{- end -}}

{{- define "novamail.dsn.selectorLabels" -}}
app.kubernetes.io/name: {{ include "novamail.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: dsn
{{- end -}}

{{- define "novamail.adminImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s/admin-api:%s" .Values.image.registry $tag -}}
{{- end -}}

{{- define "novamail.admin.selectorLabels" -}}
app.kubernetes.io/name: {{ include "novamail.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: admin-api
{{- end -}}

{{- define "novamail.webImage" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s/web:%s" .Values.image.registry $tag -}}
{{- end -}}

{{- define "novamail.web.selectorLabels" -}}
app.kubernetes.io/name: {{ include "novamail.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end -}}

{{- define "novamail.depsEnvFrom" -}}
- secretRef:
    name: {{ .Values.secrets.postgres }}
- secretRef:
    name: {{ .Values.secrets.rabbitmq }}
{{- end -}}

{{/* Postgres mTLS client material (CA + client cert) mounted for verify-full + client auth */}}
{{- define "novamail.pgtls.volumeMount" -}}
{{- if .Values.pgmtls.enabled }}
- name: pgtls
  mountPath: {{ .Values.pgmtls.mountPath }}
  readOnly: true
{{- end }}
{{- end -}}

{{- define "novamail.pgtls.volume" -}}
{{- if .Values.pgmtls.enabled }}
- name: pgtls
  projected:
    defaultMode: 0644
    sources:
      - secret:
          name: {{ .Values.pgmtls.caSecret }}
          items:
            - { key: ca.crt, path: ca.crt }
      - secret:
          name: {{ .Values.pgmtls.clientSecret }}
          items:
            - { key: tls.crt, path: tls.crt }
            - { key: tls.key, path: tls.key }
{{- end }}
{{- end -}}
