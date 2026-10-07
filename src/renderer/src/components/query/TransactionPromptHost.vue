<script setup lang="ts">
import { computed } from 'vue'
import {
  answerTransactionPrompt,
  transactionPrompt
} from '@renderer/composables/useTransactionPrompt'

/** «Confirmar / Deshacer / Cancelar» for a query tab session with an open transaction. */
const open = computed({
  get: () => transactionPrompt.open,
  set: (value: boolean) => {
    if (!value) answerTransactionPrompt('cancel')
  }
})
</script>

<template>
  <v-dialog v-model="open" max-width="460" data-test="transaction-prompt">
    <v-card>
      <v-card-title class="d-flex align-center ga-3">
        <span class="nd-icon-badge"><v-icon icon="mdi-swap-horizontal-bold" size="18" /></span>
        {{ transactionPrompt.title }}
      </v-card-title>
      <v-card-text>{{ transactionPrompt.message }}</v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn data-test="transaction-cancel" @click="answerTransactionPrompt('cancel')"
          >Cancelar</v-btn
        >
        <v-btn
          color="warning"
          variant="tonal"
          data-test="transaction-rollback"
          @click="answerTransactionPrompt('rollback')"
          >Deshacer</v-btn
        >
        <v-btn
          v-if="!transactionPrompt.failed"
          color="primary"
          variant="flat"
          data-test="transaction-commit"
          @click="answerTransactionPrompt('commit')"
          >Confirmar</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
